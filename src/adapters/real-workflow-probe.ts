/**
 * Opt-in real coding-workflow harness *probe* execution layer (NGX-372 /
 * Adapter Test Coverage milestone).
 *
 * `src/real-workflow-smoke.ts` owns the pure gate (`planWorkflowHarnessSmoke`)
 * and the pure spawn-result mapping (`classifyProbeSpawnResult`) plus taxonomy
 * (`classifyWorkflowHarnessOutcome`). That module documents that it "never
 * performs I/O". This sibling is the thin layer that *does* perform the two I/O
 * operations the opt-in harness-probe smoke needs, keeping the gate pure:
 *
 *   - `runHarnessProbe` spawns the resolved live-wrapper pre-flight probe (a
 *     cheap availability check) with the same bounded `spawnSync` discipline as
 *     `src/acp-runner.ts`, then delegates the outcome mapping to the pure
 *     `classifyProbeSpawnResult`.
 *   - `loadRawWorkflowProfileFromEnv` reads the operator-pointed live-wrapper
 *     profile JSON so the gated smoke can resolve a real wrapper command. It
 *     fails closed to `undefined` (the planner then skips with
 *     `profile_unavailable`) rather than throwing.
 *
 * It deliberately does not spawn the full agent, persist leases, capture result
 * files, or run the verification/commit transaction — those stay owned by the
 * live step wrapper / orchestrator layers and the coding-workflow-pipeline skill.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";

import type { LiveWrapperProbeConfig } from "./live-wrapper-registry.js";
import {
  classifyProbeSpawnResult,
  type WorkflowHarnessRawOutcome
} from "../real-workflow-smoke.js";

/** Points the opt-in harness-probe smoke at a live-wrapper profile JSON document. */
export const REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR =
  "MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE";

/** Bounds probe stdout/stderr; a pre-flight availability probe is not expected to be chatty. */
const PROBE_OUTPUT_MAX_BYTES = 1024 * 1024;

export type RunHarnessProbeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function buildHarnessProbeEnv(
  envAllow: readonly string[],
  source: Record<string, string | undefined> = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of envAllow) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Spawn a resolved live-wrapper pre-flight probe and reduce the finished
 * process to the harness-smoke raw outcome taxonomy. The probe `command` is
 * already validated absolute by the live-wrapper registry, so this runs with
 * no shell (`shell: false`) and an exact argv. The timeout is enforced by
 * `spawnSync` and surfaces through `classifyProbeSpawnResult` as `timed_out`.
 */
export function runHarnessProbe(
  probe: LiveWrapperProbeConfig,
  options: RunHarnessProbeOptions = {}
): WorkflowHarnessRawOutcome {
  let spawn: SpawnSyncReturns<string>;
  try {
    spawn = spawnSync(probe.command, [...probe.args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? {},
      timeout: probe.timeoutSec * 1000,
      encoding: "utf-8",
      maxBuffer: PROBE_OUTPUT_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
  } catch (error) {
    // spawnSync surfaces ENOENT/timeout through the returned result, not a
    // throw; a thrown error is an unexpected startup failure (e.g. bad argv).
    const err = error as NodeJS.ErrnoException;
    return {
      kind: "spawn_error",
      code: err.code ?? null,
      message: err instanceof Error ? err.message : String(error)
    };
  }

  return classifyProbeSpawnResult(
    {
      error: (spawn.error as (Error & { code?: string }) | undefined) ?? null,
      status: spawn.status,
      signal: spawn.signal ?? null
    },
    probe
  );
}

/**
 * Read the operator-pointed live-wrapper profile JSON so the gated smoke can
 * resolve a real wrapper command without coupling the pure planner to the
 * filesystem. Fails closed to `undefined` on a missing env var, unreadable
 * path, or invalid JSON; `planWorkflowHarnessSmoke` then skips with
 * `profile_unavailable`.
 */
export function loadRawWorkflowProfileFromEnv(
  env: Record<string, string | undefined>
): unknown {
  const profilePath = env[REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR]?.trim();
  if (!profilePath) return undefined;
  try {
    return JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  } catch {
    return undefined;
  }
}
