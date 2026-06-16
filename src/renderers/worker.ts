import type { StaleLeasePreCheckSnapshot } from "../core/daemon/status.js";
import type { WorkerRunResult } from "../core/daemon/worker-run.js";
import { write, writeJson, type CliIo } from "./cli-output.js";

type JsonFlags = {
  json: boolean;
};

export function emitWorkerRunResult(
  parsed: JsonFlags,
  io: CliIo,
  result: WorkerRunResult,
  stalePreCheck: StaleLeasePreCheckSnapshot
): number {
  const preCheckJson = summarizeStalePreCheckForJson(stalePreCheck);
  if (parsed.json) {
    const base = {
      command: "worker run",
      ...result,
      stalePreCheck: preCheckJson
    };
    const payload = {
      ok: result.code === "ran_job" ? result.ok : true,
      ...base
    } as Record<string, unknown>;

    writeJson(io.stdout, payload);
    return result.code === "no_work" || result.code === "not_executed"
      ? 0
      : result.ok
        ? 0
        : 1;
  }

  emitStalePreCheckText(io, stalePreCheck);

  if (result.code === "no_work") {
    write(io.stdout, `${result.message}\n`);
    return 0;
  }

  if (result.code === "not_executed") {
    write(io.stdout, `${result.message}\n`);
    return 0;
  }

  const status = result.ok ? "succeeded" : "failed";
  write(io.stdout, [
    `Worker ${result.workerId} ${status} goal ${result.goalId} iteration ${result.iteration}`,
    `Job: ${result.jobId}`,
    `Lock: ${result.lockId}`,
    `Repo: ${result.repoRoot}`,
    `Goal state: ${result.goalState}`,
    `Job state: ${result.jobState}`,
    ""
  ].join("\n"));

  return result.ok ? 0 : 1;
}

export function summarizeStalePreCheckForJson(
  snapshot: StaleLeasePreCheckSnapshot
): Record<string, unknown> {
  return {
    observedAt: snapshot.observedAt,
    staleLeaseGraceMs: snapshot.staleLeaseGraceMs,
    staleRepoLockCount: snapshot.staleRepoLocks.length,
    staleClaimedJobCount: snapshot.staleClaimedJobs.length,
    staleRepoLocks: snapshot.staleRepoLocks,
    staleClaimedJobs: snapshot.staleClaimedJobs
  };
}

export function emitStalePreCheckText(
  io: CliIo,
  snapshot: StaleLeasePreCheckSnapshot
): void {
  const lockCount = snapshot.staleRepoLocks.length;
  const claimCount = snapshot.staleClaimedJobs.length;
  if (lockCount === 0 && claimCount === 0) return;
  write(
    io.stdout,
    `Stale leases observed before claim: ${lockCount} repo lock(s), ${claimCount} claimed job(s) — see \`momentum daemon status\` for details.\n`
  );
}
