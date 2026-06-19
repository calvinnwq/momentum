/**
 * Daemon-lane dispatched-step execution-context derivation (RC-5b, NGX-492).
 *
 * The live-wrapper dispatch composition (`live-wrapper-dispatch.ts`) runs a
 * dispatched step's executor through `executeAndReconcileDispatchedWorkflowStep`
 * (`dispatch-executor-run.ts`), which needs a {@link DispatchedStepExecutorContext}:
 * the repo the bounded session operates on, its working directory, and the
 * result / log paths. That wrapper takes the deriver by injection precisely so the
 * daemon lane owns the run-dir layout decision; iterations 3 and 4 deferred it here.
 *
 * This module owns that decision. It is split into a pure resolver
 * ({@link resolveDispatchedStepExecutorContext}) and the injected IO loader
 * ({@link loadDispatchedStepRunProvenance}) that reads the durable run row — the
 * same pure-decision / injected-IO split `daemon-live-wrapper-profile.ts` uses.
 *
 * Run-dir layout (the deferred design decision, now settled to match existing
 * precedent):
 *
 *   - **native run** (`repo_path` set, no `source_artifact_path`): the session runs
 *     under `<repoPath>/.agent-workflows/<runId>/`, matching the agent-workflows
 *     directory convention the scheduler's recovery-artifact writer already uses
 *     (`scheduler.ts`).
 *   - **imported run** (`source_artifact_path` set): the session runs under the run
 *     dir derived from the source artifact — `path.dirname(source_artifact_path)` —
 *     mirroring the scheduler's recovery-artifact run-dir derivation and `status.ts`
 *     evidence-link matching for imported runs.
 *
 * The result / log file names (`result.json` / `executor.log`) are advisory: a
 * configured live wrapper owns its result file via its profile `result_file`
 * relative to `runDir`, so these are low-stakes defaults that mirror the existing
 * dispatch tests' fixtures.
 *
 * Honest refusal: a run with no `repo_path` (a definition-only row, or an imported
 * run that never recorded a repo) has no working directory a live command could be
 * run in. Rather than fabricate one, the resolver refuses with
 * `missing_repo_path` so the daemon lane can fail closed into manual recovery — the
 * same "never fabricate" posture RC-5 took for unconfigured executor adapters.
 */

import path from "node:path";

import type { MomentumDb } from "../../adapters/db.js";
import type { DispatchedStepExecutorContext } from "./dispatch-executor-run.js";

/**
 * The run-provenance fields the deriver reads from a durable `workflow_runs` row.
 * Both columns are nullable in the schema; the resolver maps the combinations the
 * daemon lane can encounter to a concrete session layout or an honest refusal.
 */
export type DispatchedStepRunProvenance = {
  repoPath: string | null;
  sourceArtifactPath: string | null;
};

/**
 * The outcome of resolving a dispatched step's execution context. Total over the
 * run-provenance combinations: a run with a repo resolves to a concrete session
 * layout; a run with no repo is refused rather than given a fabricated directory.
 */
export type DispatchedStepExecutorContextResolution =
  | { ok: true; exec: DispatchedStepExecutorContext }
  | { ok: false; reason: "missing_repo_path" };

/** Whether a nullable durable string column carries a usable, non-blank value. */
function nonBlank(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}

/**
 * Resolve the {@link DispatchedStepExecutorContext} for a dispatched step from its
 * run's provenance. Pure: derives the session layout from `runId` plus the run-row
 * columns only. See the module doc for the native / imported run-dir layout and the
 * honest `missing_repo_path` refusal.
 */
export function resolveDispatchedStepExecutorContext(
  runId: string,
  provenance: DispatchedStepRunProvenance
): DispatchedStepExecutorContextResolution {
  if (!nonBlank(provenance.repoPath)) {
    return { ok: false, reason: "missing_repo_path" };
  }

  const repoPath = provenance.repoPath;
  const runDir = nonBlank(provenance.sourceArtifactPath)
    ? path.dirname(provenance.sourceArtifactPath)
    : path.join(repoPath, ".agent-workflows", runId);

  return {
    ok: true,
    exec: {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log")
    }
  };
}

/**
 * Load a run's dispatch provenance (`repo_path`, `source_artifact_path`) from the
 * durable `workflow_runs` row, or `undefined` when the run row no longer exists.
 * The injected IO half of the deriver; the daemon lane passes the resolved
 * provenance to {@link resolveDispatchedStepExecutorContext}.
 */
export function loadDispatchedStepRunProvenance(
  db: MomentumDb,
  runId: string
): DispatchedStepRunProvenance | undefined {
  const row = db
    .prepare(
      "SELECT repo_path, source_artifact_path FROM workflow_runs WHERE id = ?"
    )
    .get(runId) as
    | { repo_path: string | null; source_artifact_path: string | null }
    | undefined;
  if (row === undefined) return undefined;
  return {
    repoPath: row.repo_path,
    sourceArtifactPath: row.source_artifact_path
  };
}
