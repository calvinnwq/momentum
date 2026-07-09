/**
 * Production start-or-attach child-run runner builder for the `subworkflow`
 * executor family.
 *
 * The the subworkflow seam producer (`dispatch/subworkflow-run.ts`) drives a dispatched
 * `subworkflow` step through an injected {@link DispatchedSubworkflowChildRunner}
 * — the parent step never reaches into the child's runtime; it starts or attaches
 * to the child run through the existing workflow-owned seams and observes that
 * child run's state. the subworkflow seam's integration proof built such a runner, but only as a
 * *test-only* helper that hardcoded `CODING_WORKFLOW_DEFINITION` as the child
 * recipe (`workflow-dispatch-subworkflow-child-run.test.ts`).
 *
 * Production cannot hardcode the child recipe: a configured `subworkflow` step
 * names its child by key (validated into a {@link SubworkflowChildDefinitionConfig}
 * by iteration 1 and route-sourced by iteration 2), so the runner the daemon lane
 * injects must resolve that key against the durable definition store and fail
 * closed when it does not resolve. This module owns exactly that — the keystone IO
 * the entry-point factory's {@link DeriveDispatchedSubworkflowContext} composes —
 * and nothing else: it does not itself touch
 * `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES` or wire any daemon lane; the production lane
 * flipped `subworkflow` into that allowlist and wired the production
 * lane that injects this runner once the configured lane was proven.
 *
 * Discipline (the same pure-decision / injected-IO split
 * `live-wrapper/daemon-exec-context.ts` uses for the live-wrapper lane):
 *
 *   - {@link buildDispatchedSubworkflowChildRunner} resolves the child
 *     {@link WorkflowDefinition} by key *once*, at build (derive) time. A key that
 *     does not resolve is a stable fail-closed refusal (`{ ok: false }`) the
 *     caller routes to manual recovery with a clean operator-facing reason — never
 *     a runner that throws on every tick. The contract's "unsupported attachment"
 *     fail-closed case.
 *   - On success it returns a start-or-attach {@link DispatchedSubworkflowChildRunner}.
 *     The first tick durably starts the child run from the resolved definition with
 *     the propagated child route; a later tick hits the run-start conflict guard and
 *     *attaches* to the SAME child run only after verifying the existing row is the
 *     expected child definition. A conflicting row at the deterministic child id is
 *     an unsupported attachment and fails closed instead of silently observing an
 *     unrelated run. Each tick re-observes the child's real state through the
 *     status read-back seam and mirrors its needs-manual-recovery flags onto the
 *     observation the producer's mirror mapping consumes.
 *   - It never reaches into the child run's steps / gates / terminal state: the
 *     child run is a first-class `workflow_runs` row that owns its own lifecycle,
 *     exactly as subworkflow parent/child ownership boundary requires. A genuinely
 *     unexpected failure (the child row vanishing after a successful start/attach,
 *     or an invalid run-start the parent facts should have precluded) rejects so a
 *     re-entered tick retries the still-non-terminal scaffold, and the entry-point
 *     factory traps the rejection into the same manual-recovery park.
 */

import type { MomentumDb } from "../../../adapters/db.js";
import type { WorkflowDefinition } from "../definition/definition.js";
import { loadWorkflowDefinition } from "../definition/persist.js";
import type { DispatchedSubworkflowChildRunner } from "../dispatch/subworkflow-run.js";
import {
  persistWorkflowRunStart,
  WorkflowRunStartConflictError
} from "../run/start-persist.js";
import { loadWorkflowRunDetail } from "../run/status.js";

/**
 * Everything the builder needs to resolve and drive a dispatched `subworkflow`
 * step's child run. The daemon-lane deriver assembles it from the parent run's
 * durable facts and iteration 2's route-sourced launch plan: `childRunId`,
 * `childDefinitionKey`, and `childRoute` come from
 * {@link planSubworkflowChildLaunchFromRoute}; `repoPath` / `objective` come from
 * the parent run row.
 */
export type BuildDispatchedSubworkflowChildRunnerInput = {
  db: MomentumDb;
  /** The deterministic child run id (start-or-attach idempotency anchor). */
  childRunId: string;
  /** The workflow definition key the child run launches (resolved here). */
  childDefinitionKey: string;
  /** The workflow definition version the child run launches (resolved here). */
  childDefinitionVersion: number;
  /** The `route` JSON the child run is started with (lineage propagated). */
  childRoute: Record<string, unknown>;
  /** The repo the child run operates on (inherited from the parent run). */
  repoPath: string;
  /** The child run's objective (inherited / shaped from the parent run). */
  objective: string;
  now: number;
};

/**
 * The outcome of building the child runner: the start-or-attach runner the
 * producer drives, or a stable fail-closed refusal (`ok: false`) with an
 * operator-facing reason the caller routes to manual recovery. The only build-time
 * refusal is an unresolved child definition key.
 */
export type DispatchedSubworkflowChildRunnerResolution =
  | { ok: true; run: DispatchedSubworkflowChildRunner }
  | { ok: false; reason: string };

/**
 * Resolve the child definition by key and, on success, build the production
 * start-or-attach {@link DispatchedSubworkflowChildRunner}. See the module doc for
 * the build-time definition resolution, the start-or-attach idempotency, and the
 * parent/child ownership boundary.
 */
export function buildDispatchedSubworkflowChildRunner(
  input: BuildDispatchedSubworkflowChildRunnerInput
): DispatchedSubworkflowChildRunnerResolution {
  const definition = loadWorkflowDefinition(
    input.db,
    input.childDefinitionKey,
    input.childDefinitionVersion
  );
  if (definition === undefined) {
    return {
      ok: false,
      reason: `Subworkflow child definition '${formatDefinitionRef(input.childDefinitionKey, input.childDefinitionVersion)}' is not persisted; routing to manual recovery.`
    };
  }

  const existingAttachment = loadChildRunAttachment(input.db, input.childRunId);
  if (
    existingAttachment !== undefined &&
    !matchesExpectedAttachment(existingAttachment, input)
  ) {
    return {
      ok: false,
      reason: unsupportedAttachmentReason(
        input.childRunId,
        input.childDefinitionKey,
        input.childDefinitionVersion,
        existingAttachment.definitionKey,
        existingAttachment.definitionVersion
      )
    };
  }

  const run: DispatchedSubworkflowChildRunner = async () =>
    startOrAttachAndObserveChildRun(input, definition);

  return { ok: true, run };
}

function startOrAttachAndObserveChildRun(
  input: BuildDispatchedSubworkflowChildRunnerInput,
  definition: WorkflowDefinition
) {
  const { db, childRunId, childRoute, repoPath, objective, now } = input;

  try {
    persistWorkflowRunStart(db, {
      definition,
      runId: childRunId,
      repoPath,
      objective,
      route: childRoute,
      now
    });
  } catch (error) {
    // Attach: a prior tick already started this child run. Idempotent re-entry —
    // never start a second child run; verify the existing row is the expected
    // child definition, then fall through to observe it.
    // Any other failure (e.g. an invalid run-start the parent facts should have
    // precluded) propagates so the entry-point factory parks the step for manual
    // recovery rather than silently mis-observing.
    if (!(error instanceof WorkflowRunStartConflictError)) throw error;
    const attached = loadChildRunAttachment(db, childRunId);
    if (attached === undefined || !matchesExpectedAttachment(attached, input)) {
      throw new Error(
        unsupportedAttachmentReason(
          childRunId,
          input.childDefinitionKey,
          input.childDefinitionVersion,
          attached?.definitionKey ?? null,
          attached?.definitionVersion ?? null
        )
      );
    }
  }

  const detail = loadWorkflowRunDetail(db, childRunId);
  if (detail === null) {
    throw new Error(
      `Subworkflow child run ${childRunId} not found after start/attach.`
    );
  }

  return {
    childRunId,
    childState: detail.run.state,
    childNeedsManualRecovery: detail.run.needsManualRecovery,
    childManualRecoveryReason: detail.run.manualRecoveryReason
  };
}

function loadChildRunAttachment(
  db: MomentumDb,
  runId: string
): { definitionKey: string | null; definitionVersion: number | null } | undefined {
  const row = db
    .prepare(
      "SELECT workflow_definition_key, workflow_definition_version FROM workflow_runs WHERE id = ?"
    )
    .get(runId) as
    | {
        workflow_definition_key: string | null;
        workflow_definition_version: number | null;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    definitionKey: row.workflow_definition_key,
    definitionVersion: row.workflow_definition_version
  };
}

function matchesExpectedAttachment(
  attachment: { definitionKey: string | null; definitionVersion: number | null },
  input: BuildDispatchedSubworkflowChildRunnerInput
): boolean {
  return (
    attachment.definitionKey === input.childDefinitionKey &&
    attachment.definitionVersion === input.childDefinitionVersion
  );
}

function unsupportedAttachmentReason(
  childRunId: string,
  expectedDefinitionKey: string,
  expectedDefinitionVersion: number,
  actualDefinitionKey: string | null,
  actualDefinitionVersion: number | null
): string {
  return (
    `Subworkflow child run ${childRunId} already exists for definition ` +
    `'${formatDefinitionRef(actualDefinitionKey, actualDefinitionVersion)}' instead of ` +
    `'${formatDefinitionRef(expectedDefinitionKey, expectedDefinitionVersion)}'; ` +
    "routing to manual recovery."
  );
}

function formatDefinitionRef(
  definitionKey: string | null,
  definitionVersion: number | null
): string {
  if (definitionKey === null || definitionVersion === null) return "<unlinked>";
  return `${definitionKey}@${definitionVersion}`;
}
