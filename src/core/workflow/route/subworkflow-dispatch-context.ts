/**
 * Daemon-lane child-run context deriver for the `subworkflow` executor.
 *
 * The subworkflow seam entry-point factory (`dispatch/subworkflow-dispatch.ts`)
 * takes its child-run derivation by injection — a
 * {@link DeriveDispatchedSubworkflowContext} — precisely so the daemon lane owns
 * building the start-or-attach runner and the evidence paths from the existing
 * workflow-owned seams, and the wrapper stays agnostic to *how* the child is
 * driven.
 *
 * The deriver reads canonical durable state directly — no compatibility route
 * projection is consulted anywhere on this path:
 *
 *   - the claimed step's own `workflow_steps.executor_config_json` row is the
 *     only source of subworkflow child intent
 *     ({@link loadClaimedSubworkflowStepConfig});
 *   - the parent run's `workflow_run_lineage` row is the only source of parent,
 *     depth, and ancestry facts ({@link loadSubworkflowRunLineageRow}); an
 *     absent row is a legitimate top-level run, a corrupt row fails closed;
 *   - the parent run row supplies the definition key, inherited objective, and
 *     repo facts ({@link loadSubworkflowParentRunRow} /
 *     {@link resolveSubworkflowParentRunFacts}).
 *
 * The pure `planSubworkflowChildLaunchFromStep` composes config validation,
 * canonical ancestry, and the recursion-safety decider; the landed
 * `buildDispatchedSubworkflowChildRunner` resolves the child definition and
 * returns the production start-or-attach runner, now carrying the explicit
 * child lineage the start-persistence seam inserts atomically.
 *
 * Discipline (the pure-decision / injected-IO split
 * `live-wrapper/daemon-exec-context.ts` uses, and total so the factory never has
 * to handle a thrown derivation specially): every shortfall — a vanished run, an
 * unlinked / objectiveless run, a missing or corrupt step config, a corrupt
 * lineage, a repo-less run, or an unresolved child definition — returns
 * `{ ok: false }` with an operator-facing reason; only a fully resolved,
 * recursion-safe, key-resolved child returns `{ ok: true }`. The child run
 * itself is not started here — that is the returned runner's job on the first
 * producer tick.
 *
 * Wiring: this deriver is injected into the daemon dispatch composition
 * (`withSubworkflowDispatch` wrapping the base dispatch via
 * {@link createSubworkflowWorkflowDispatch}), with `subworkflow` in
 * `PHASE1_DISPATCHABLE_EXECUTORS`, so a configured `subworkflow` step dispatches
 * its child run through bounded `daemon start`.
 */

import path from "node:path";

import type { MomentumDb } from "../../../adapters/db.js";
import { resolveDispatchedStepExecutorContext } from "../live-wrapper/daemon-exec-context.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatchContext,
} from "../dispatch/scheduler.js";
import { buildDispatchedSubworkflowChildRunner } from "./subworkflow-child-runner.js";
import type { DispatchedSubworkflowContextResolution } from "../dispatch/subworkflow-dispatch.js";
import {
  planSubworkflowChildLaunchFromStep,
  readSubworkflowCanonicalLineage,
  type SubworkflowCanonicalLineage,
} from "./subworkflow.js";

/**
 * The raw `workflow_runs` columns the deriver reads from a parent run row. Every
 * column is nullable in the schema; {@link resolveSubworkflowParentRunFacts} maps
 * the combinations the daemon lane can encounter to validated facts or an honest
 * refusal.
 */
export type SubworkflowParentRunRow = {
  /** The run's own workflow definition key (the recursion self-reference anchor). */
  definitionKey: string | null;
  /** The run's objective (inherited by the child run). */
  objective: string | null;
  /** The run's repo (inherited by the child run + the run-dir layout anchor). */
  repoPath: string | null;
  /** The imported run's source artifact path (run-dir layout for imported runs). */
  sourceArtifactPath: string | null;
};

/**
 * The validated parent run facts the child launch needs: the run's own
 * definition key, the inherited objective, and the repo facts passed through to
 * the run-dir resolver.
 */
export type SubworkflowParentRunFacts = {
  definitionKey: string;
  objective: string;
  repoPath: string | null;
  sourceArtifactPath: string | null;
};

export type SubworkflowParentRunFactsResolution =
  | { ok: true; facts: SubworkflowParentRunFacts }
  | { ok: false; reason: string };

function nonBlank(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parent run row into the facts the child launch needs. Pure and
 * total: a definition-unlinked or objectiveless run is refused. `repoPath` /
 * `sourceArtifactPath` pass through to the run-dir resolver, which owns the
 * "no repo to host a child" refusal.
 */
export function resolveSubworkflowParentRunFacts(
  runId: string,
  row: SubworkflowParentRunRow,
): SubworkflowParentRunFactsResolution {
  if (!nonBlank(row.definitionKey)) {
    return {
      ok: false,
      reason: `Subworkflow parent run ${runId} is not linked to a workflow definition; routing to manual recovery.`,
    };
  }
  if (!nonBlank(row.objective)) {
    return {
      ok: false,
      reason: `Subworkflow parent run ${runId} has no objective to inherit; routing to manual recovery.`,
    };
  }

  return {
    ok: true,
    facts: {
      definitionKey: row.definitionKey,
      objective: row.objective,
      repoPath: row.repoPath,
      sourceArtifactPath: row.sourceArtifactPath,
    },
  };
}

/**
 * Load a parent run's subworkflow-dispatch facts from the durable
 * `workflow_runs` row, or `undefined` when the run row no longer exists. The
 * injected IO half of the deriver.
 */
export function loadSubworkflowParentRunRow(
  db: MomentumDb,
  runId: string,
): SubworkflowParentRunRow | undefined {
  const row = db
    .prepare(
      `SELECT workflow_definition_key, objective, repo_path, source_artifact_path
         FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        workflow_definition_key: string | null;
        objective: string | null;
        repo_path: string | null;
        source_artifact_path: string | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    definitionKey: row.workflow_definition_key,
    objective: row.objective,
    repoPath: row.repo_path,
    sourceArtifactPath: row.source_artifact_path,
  };
}

export type SubworkflowStepConfigResolution =
  { ok: true; config: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Load the claimed step's own `workflow_steps.executor_config_json` — the only
 * active source of subworkflow child intent. A vanished step row or a
 * malformed / non-object config fails closed with an operator-facing reason.
 */
export function loadClaimedSubworkflowStepConfig(
  db: MomentumDb,
  runId: string,
  stepId: string,
): SubworkflowStepConfigResolution {
  const row = db
    .prepare(
      "SELECT executor_config_json FROM workflow_steps WHERE run_id = ? AND step_id = ?",
    )
    .get(runId, stepId) as { executor_config_json: string } | undefined;
  if (row === undefined) {
    return {
      ok: false,
      reason: `Subworkflow step ${runId}/${stepId} not found; routing to manual recovery.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.executor_config_json);
  } catch {
    return {
      ok: false,
      reason: `Subworkflow step ${runId}/${stepId} has corrupt executor config; routing to manual recovery.`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      reason: `Subworkflow step ${runId}/${stepId} executor config is not an object; routing to manual recovery.`,
    };
  }
  return { ok: true, config: parsed };
}

export type SubworkflowRunLineageResolution =
  | { ok: true; lineage: SubworkflowCanonicalLineage | null }
  | { ok: false; reason: string };

/**
 * Load a run's canonical `workflow_run_lineage` row — the only active source of
 * parent, depth, and ancestry facts. An absent row is a legitimate top-level
 * run (`lineage: null`, an empty ancestor list); a present-but-corrupt row
 * fails closed rather than resetting recursion state to top-level.
 */
export function loadSubworkflowRunLineageRow(
  db: MomentumDb,
  runId: string,
): SubworkflowRunLineageResolution {
  const row = db
    .prepare(
      `SELECT parent_run_id, parent_step_id, depth,
              ancestor_definition_keys_json
         FROM workflow_run_lineage WHERE run_id = ?`,
    )
    .get(runId) as
    | {
        parent_run_id: string;
        parent_step_id: string;
        depth: number;
        ancestor_definition_keys_json: string;
      }
    | undefined;
  if (row === undefined) return { ok: true, lineage: null };
  const read = readSubworkflowCanonicalLineage(runId, {
    parentRunId: row.parent_run_id,
    parentStepId: row.parent_step_id,
    depth: row.depth,
    ancestorDefinitionKeysJson: row.ancestor_definition_keys_json,
  });
  if (!read.ok) return { ok: false, reason: read.reason };
  return { ok: true, lineage: read.lineage };
}

/**
 * Derive a dispatched `subworkflow` step's child-run context: read the parent
 * run facts, the claimed step's own child intent, and the canonical lineage
 * row; plan the recursion-safe child launch; derive the parent-run-dir evidence
 * paths; and build the start-or-attach child runner. See the module doc for the
 * fail-closed taxonomy. Matches {@link DeriveDispatchedSubworkflowContext} so
 * the entry-point factory injects it directly; it is synchronous (the actual
 * child start happens when the returned runner is called by the producer).
 */
export function deriveDispatchedSubworkflowContext(
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext,
): DispatchedSubworkflowContextResolution {
  const row = loadSubworkflowParentRunRow(context.db, claim.runId);
  if (row === undefined) {
    return {
      ok: false,
      reason: `Subworkflow parent run ${claim.runId} not found; routing to manual recovery.`,
    };
  }

  const facts = resolveSubworkflowParentRunFacts(claim.runId, row);
  if (!facts.ok) return facts;

  const stepConfig = loadClaimedSubworkflowStepConfig(
    context.db,
    claim.runId,
    claim.stepId,
  );
  if (!stepConfig.ok) return { ok: false, reason: stepConfig.reason };

  const lineage = loadSubworkflowRunLineageRow(context.db, claim.runId);
  if (!lineage.ok) return { ok: false, reason: lineage.reason };

  const plan = planSubworkflowChildLaunchFromStep({
    parentRunId: claim.runId,
    parentStepId: claim.stepId,
    parentDefinitionKey: facts.facts.definitionKey,
    stepExecutorConfig: stepConfig.config,
    parentLineage: lineage.lineage,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const execContext = resolveDispatchedStepExecutorContext(claim.runId, {
    repoPath: facts.facts.repoPath,
    sourceArtifactPath: facts.facts.sourceArtifactPath,
  });
  if (!execContext.ok) {
    return {
      ok: false,
      reason: `Subworkflow parent run ${claim.runId} has no repo path to host a child run; routing to manual recovery.`,
    };
  }

  const built = buildDispatchedSubworkflowChildRunner({
    db: context.db,
    childRunId: plan.childRunId,
    childDefinitionKey: plan.childDefinitionKey,
    childDefinitionVersion: plan.childDefinitionVersion,
    childLineage: plan.childLineage,
    repoPath: execContext.exec.repoPath,
    objective: facts.facts.objective,
    now: context.now,
  });
  if (!built.ok) return { ok: false, reason: built.reason };

  return {
    ok: true,
    runSubworkflowChild: built.run,
    evidence: {
      executorLogPath: path.join(execContext.exec.runDir, "subworkflow.log"),
      resultJsonPath: path.join(execContext.exec.runDir, "subworkflow.json"),
    },
  };
}
