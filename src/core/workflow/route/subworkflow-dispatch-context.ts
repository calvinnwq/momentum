/**
 * Daemon-lane child-run context deriver for the `subworkflow` executor
 *.
 *
 * The landed the subworkflow seam entry-point factory (`dispatch/subworkflow-dispatch.ts`) takes its
 * child-run derivation by injection — a {@link DeriveDispatchedSubworkflowContext}
 * — precisely so the daemon lane owns building the start-or-attach runner and the
 * evidence paths from the existing workflow-owned seams, and the wrapper stays
 * agnostic to *how* the child is driven. Iterations 1-3 landed the pieces that
 * derivation composes; this module is the connective IO that assembles them:
 *
 *   - iteration 1 (`route/subworkflow-child-config.ts`): the child-config shape +
 *     recursion-safety deciders;
 *   - iteration 2 (`route/subworkflow.ts`): {@link planSubworkflowChildLaunchFromRoute},
 *     which sources the child config from `route.subworkflow.child` and the durable
 *     recursion lineage from `route.subworkflow.lineage`, returning a launch plan
 *     (child definition key, deterministic child run id, propagated child route) or
 *     a typed fail-closed refusal;
 *   - iteration 3 (`route/subworkflow-child-runner.ts`):
 *     {@link buildDispatchedSubworkflowChildRunner}, which resolves the child
 *     definition by key and returns the production start-or-attach runner.
 *
 * The deriver reads the parent run's durable facts (its `route`, definition key,
 * objective, and repo) from the `workflow_runs` row, runs the iteration-2 launch
 * plan over them, derives the parent-run-dir evidence paths, builds the iteration-3
 * runner, and returns the {@link DispatchedSubworkflowContextResolution} the
 * factory forwards into the producer (or routes to manual recovery on any refusal).
 *
 * Discipline (the pure-decision / injected-IO split `live-wrapper/daemon-exec-context.ts`
 * uses, and total so the factory never has to handle a thrown derivation specially):
 *
 *   - {@link resolveSubworkflowParentRunFacts} is the pure half: it validates the
 *     raw run-row columns the launch plan needs (a definition-linked run, a
 *     non-blank inherited objective) and parses `route_json` — failing closed on a
 *     corrupt route rather than throwing, the same posture the route module takes
 *     for a corrupt lineage. `repo_path` is passed through and owned by the reused
 *     {@link resolveDispatchedStepExecutorContext} run-dir resolver, which already
 *     refuses a run with no repo to host a child.
 *   - {@link loadSubworkflowParentRunRow} is the injected IO half: it reads the
 *     durable row, or `undefined` when the run vanished between claim and dispatch.
 *   - {@link deriveDispatchedSubworkflowContext} composes them. Every shortfall —
 *     a vanished run, an unlinked/objectiveless run, a corrupt route, a
 *     missing/unsafe child config, a corrupt lineage, a repo-less run, or an
 *     unresolved child definition — returns `{ ok: false }` with an operator-facing
 *     reason; only a fully resolved, recursion-safe, key-resolved child returns
 *     `{ ok: true }`. The child run itself is not started here — that is the
 *     returned runner's job on the first producer tick.
 *
 * Wiring: this deriver is injected into the daemon dispatch
 * composition (`withSubworkflowDispatch` in `cli.ts`, wrapping the base dispatch
 * via {@link createSubworkflowWorkflowDispatch}), with `subworkflow` flipped into
 * `PHASE1_DISPATCHABLE_EXECUTORS`, so a configured `subworkflow` step now
 * dispatches its child run through bounded `daemon start`.
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
import { planSubworkflowChildLaunchFromRoute } from "./subworkflow.js";

/**
 * The raw `workflow_runs` columns the deriver reads from a parent run row. Every
 * column is nullable in the schema; {@link resolveSubworkflowParentRunFacts} maps
 * the combinations the daemon lane can encounter to validated facts or an honest
 * refusal.
 */
export type SubworkflowParentRunRow = {
  /** The run's free-form `route` JSON (carries the subworkflow config + lineage). */
  routeJson: string | null;
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
 * The validated parent run facts the child launch needs: the parsed `route`, the
 * run's own definition key, the inherited objective, and the repo facts passed
 * through to the run-dir resolver.
 */
export type SubworkflowParentRunFacts = {
  route: Record<string, unknown>;
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
 * Validate a parent run row into the facts the child launch needs. Pure and total:
 * a definition-unlinked or objectiveless run is refused, and a corrupt / non-object
 * `route_json` fails closed rather than throwing (a `null` route is the legitimate
 * empty-route case). `repoPath` / `sourceArtifactPath` pass through to the run-dir
 * resolver, which owns the "no repo to host a child" refusal.
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

  let route: Record<string, unknown>;
  if (row.routeJson === null) {
    route = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.routeJson);
    } catch {
      return {
        ok: false,
        reason: `Subworkflow parent run ${runId} has a corrupt route; routing to manual recovery.`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        reason: `Subworkflow parent run ${runId} route is not an object; routing to manual recovery.`,
      };
    }
    route = parsed;
  }

  return {
    ok: true,
    facts: {
      route,
      definitionKey: row.definitionKey,
      objective: row.objective,
      repoPath: row.repoPath,
      sourceArtifactPath: row.sourceArtifactPath,
    },
  };
}

/**
 * Load a parent run's subworkflow-dispatch facts from the durable `workflow_runs`
 * row, or `undefined` when the run row no longer exists. The injected IO half of
 * the deriver.
 */
export function loadSubworkflowParentRunRow(
  db: MomentumDb,
  runId: string,
): SubworkflowParentRunRow | undefined {
  const row = db
    .prepare(
      `SELECT route_json, workflow_definition_key, objective, repo_path, source_artifact_path
         FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        route_json: string | null;
        workflow_definition_key: string | null;
        objective: string | null;
        repo_path: string | null;
        source_artifact_path: string | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    routeJson: row.route_json,
    definitionKey: row.workflow_definition_key,
    objective: row.objective,
    repoPath: row.repo_path,
    sourceArtifactPath: row.source_artifact_path,
  };
}

/**
 * Derive a dispatched `subworkflow` step's child-run context: read the parent run
 * facts, plan the recursion-safe route-sourced child launch, derive the
 * parent-run-dir evidence paths, and build the start-or-attach child runner. See
 * the module doc for the fail-closed taxonomy. Matches
 * {@link DeriveDispatchedSubworkflowContext} so the entry-point factory injects it
 * directly; it is synchronous (the actual child start happens when the returned
 * runner is called by the producer).
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

  const plan = planSubworkflowChildLaunchFromRoute({
    parentRunId: claim.runId,
    parentStepId: claim.stepId,
    parentRoute: facts.facts.route,
    parentDefinitionKey: facts.facts.definitionKey,
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
    childRoute: plan.childRoute,
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
