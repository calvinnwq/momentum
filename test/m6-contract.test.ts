import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("public docs envelope shapes", () => {
  describe("docs directory structure", () => {
    const expected = [
      "docs/runners.md",
      "docs/recovery.md",
      "docs/walkthrough.md",
      "docs/failure-reset.md",
      "docs/goal-start.md",
      "docs/daemon.md",
      "docs/worker-run.md",
      "docs/doctor.md",
      "docs/status.md",
      "docs/handoff.md",
      "docs/source-commands.md",
      "docs/evidence-commands.md",
      "docs/logs.md",
    ];
    for (const rel of expected) {
      it(`has ${rel}`, () => {
        const p = path.join(repoRoot, rel);
        expect(fs.existsSync(p), `${rel} should exist`).toBe(true);
      });
    }
  });

  describe("docs/logs.md", () => {
    const logs = readDoc(path.join("docs", "logs.md"));

    it("documents the logs CLI shape and flags", () => {
      for (const part of [
        "momentum logs",
        "<goal-id>",
        "--iteration",
        "--data-dir",
        "--json"
      ]) {
        expect(logs).toContain(part);
      }
    });

    it("documents the JSON envelope keys", () => {
      for (const key of [
        "availableIterations",
        "runnerLog",
        "verificationLog",
        "resultJson",
        "sourceItems",
        "latestEvidence"
      ]) {
        expect(logs).toContain(key);
      }
    });

    it("documents the per-file block fields", () => {
      for (const field of ["path", "exists", "readable", "bytes", "content", "error"]) {
        expect(logs).toContain(field);
      }
    });

    it("documents the iteration selection behaviour and refusal codes", () => {
      for (const phrase of [
        "highest-numbered iteration",
        "current_iteration",
        "iteration_not_found",
        "usage_error"
      ]) {
        expect(logs).toContain(phrase);
      }
    });

    it("documents the parseError behaviour and the empty / scaffold non-error rule", () => {
      expect(logs).toContain("parseError");
      expect(logs).toContain("RunnerResult");
      expect(logs).toMatch(/\{\}/);
      expect(logs).toMatch(/not (a )?parse error/i);
    });

    it("documents that logs reads only local artifacts and does not consult live worker state", () => {
      expect(logs).toMatch(/local artifacts/i);
      expect(logs).toMatch(/does not consult live worker state/i);
    });
  });

  describe("docs/evidence-commands.md", () => {
    const evidenceCommands = readDoc(path.join("docs", "evidence-commands.md"));

    it("covers the two evidence commands", () => {
      for (const cmd of ["evidence ingest", "evidence list"]) {
        expect(evidenceCommands).toContain(cmd);
      }
    });

    it("documents evidence ingest flags and supported inputs", () => {
      for (const key of [
        "--path",
        "--goal",
        "--source-item",
        ".agent-workflows",
        "plan.json",
        "ledger.jsonl",
        "approval-",
        "agent-workflow",
        "formatVersion",
        "ingestKey"
      ]) {
        expect(evidenceCommands).toContain(key);
      }
    });

    it("documents evidence ingest JSON envelope keys and counts", () => {
      for (const key of [
        "evidence_records",
        "observed",
        "created",
        "skipped",
        "diagnostics",
        "errors",
        "goalId",
        "sourceItemId",
        "dataDir"
      ]) {
        expect(evidenceCommands).toContain(key);
      }
    });

    it("documents the evidence format / ingest refusal codes", () => {
      for (const code of [
        "evidence_format_unknown",
        "evidence_format_invalid",
        "goal_not_found",
        "source_item_not_found"
      ]) {
        expect(evidenceCommands).toContain(code);
      }
    });

    it("documents evidence list filters and record field shape", () => {
      for (const key of [
        "--source",
        "--type",
        "--limit",
        "occurredAt",
        "artifactPath",
        "externalId",
        "summary",
        "metadata",
        "createdAt",
        "updatedAt"
      ]) {
        expect(evidenceCommands).toContain(key);
      }
    });

    it("documents the idempotent re-ingest behaviour", () => {
      expect(evidenceCommands).toMatch(/idempotent/i);
      expect(evidenceCommands).toMatch(/skipped/);
    });
  });

  describe("docs/source-commands.md", () => {
    const sourceCommands = readDoc(path.join("docs", "source-commands.md"));

    it("covers the six source / project commands", () => {
      for (const cmd of [
        "source list",
        "source get",
        "source link",
        "source unlink",
        "source reconcile linear",
        "project status"
      ]) {
        expect(sourceCommands).toContain(cmd);
      }
    });

    it("documents source list filters and JSON envelope keys", () => {
      for (const key of [
        "--adapter",
        "adapterKind",
        "externalId",
        "externalKey",
        "lastObservedAt",
        "lastReconciliation",
        "itemsSeen",
        "itemsUpserted",
        "paginationStopped"
      ]) {
        expect(sourceCommands).toContain(key);
      }
    });

    it("documents source get / link / unlink idempotency and refusal codes", () => {
      for (const code of [
        "source_item_not_found",
        "linked_to_other_goal",
        "already_linked_to_target",
        "currentGoalId",
        "previousGoalId",
        "link_changed",
        "data_dir_failed"
      ]) {
        expect(sourceCommands).toContain(code);
      }
    });

    it("documents source reconcile linear flags, dry-run, and refusal codes", () => {
      for (const key of [
        "LINEAR_API_KEY",
        "--dry-run",
        "--max-pages",
        "--linear-endpoint",
        "--linear-page-size",
        "source_snapshots",
        "source_reconciliation_runs",
        "itemsSampled",
        "classification",
        "source_auth_unavailable",
        "source_config_invalid",
        "unsupported_source_adapter",
        "source_adapter_threw"
      ]) {
        expect(sourceCommands).toContain(key);
      }
    });

    it("documents project status flags, defaults, and pending-intent stale flag", () => {
      for (const key of [
        "--source",
        "--project",
        "--milestone",
        "--stale-threshold-hours",
        "--intent-stale-threshold-days",
        "pendingUpdateIntents",
        "totalPendingUpdateIntentCount",
        "truncatedPendingUpdateIntents",
        "intentId",
        "ageMs"
      ]) {
        expect(sourceCommands).toContain(key);
      }
      expect(sourceCommands).toMatch(/default 24 hours/);
      expect(sourceCommands).toMatch(/default 30 days/);
    });

    it("documents the stable mismatch / reconciliation-warning / nextAction taxonomies", () => {
      for (const kind of [
        "source_done_goal_not_terminal",
        "goal_done_source_not_done",
        "evidence_missing_after_completion",
        "manual_recovery_required",
        "never_run",
        "last_failed",
        "reconcile_failed",
        "reconcile_stale_source",
        "address_mismatch",
        "review_pending_intents",
        "missing_evidence",
        "no_action_required"
      ]) {
        expect(sourceCommands).toContain(kind);
      }
    });
  });

  describe("docs/handoff.md", () => {
    const handoff = readDoc(path.join("docs", "handoff.md"));

    it("documents the snake_case JSON envelope core keys", () => {
      for (const key of [
        "goal_state",
        "current_iteration_detail",
        "next_action_detail",
        "latest_commit_sha",
        "daemon",
        "stale_recovery",
        "policy",
        "runner_profile"
      ]) {
        expect(handoff).toContain(key);
      }
    });

    it("documents handoff.md and handoff.json schema v1 artifact rendering", () => {
      expect(handoff).toContain("handoff.md");
      expect(handoff).toContain("handoff.json");
      expect(handoff).toMatch(/schema v1/i);
    });

    it("documents the runner_result_error surface for missing/malformed result artifacts", () => {
      expect(handoff).toContain("runner_result_error");
      expect(handoff).toMatch(/Runner result read error/);
    });

    it("documents recovery_md in artifacts and artifact_files", () => {
      expect(handoff).toContain("recovery_md");
      expect(handoff).toContain("artifact_files");
      expect(handoff).toMatch(/\(present\)/);
      expect(handoff).toMatch(/\(missing\)/);
    });

    it("documents the linked source_items and latest_evidence sub-blocks", () => {
      for (const key of [
        "source_items",
        "adapter_kind",
        "external_key",
        "last_observed_at",
        "latest_evidence",
        "artifact_path",
        "source_item_id"
      ]) {
        expect(handoff).toContain(key);
      }
    });

    it("documents the pending_update_intents block and stale threshold", () => {
      for (const key of [
        "pending_update_intents",
        "intent_id",
        "intent_type",
        "target_external_id",
        "intent_stale_threshold_ms"
      ]) {
        expect(handoff).toContain(key);
      }
      expect(handoff).toMatch(/momentum intent list --status pending/);
    });

    it("documents the daemon and stale_recovery sub-blocks", () => {
      for (const key of [
        "is_active",
        "is_terminal",
        "stop_request",
        "stop_now_request",
        "cancel_outcome",
        "recovered_repo_lock_count",
        "stale_lease_grace_ms"
      ]) {
        expect(handoff).toContain(key);
      }
    });

    it("documents the policy block (MOMENTUM.md, runner / verification config)", () => {
      expect(handoff).toContain("MOMENTUM.md");
      expect(handoff).toContain("has_notes");
      expect(handoff).toContain("verification_timeout_sec");
    });
  });

  describe("docs/status.md", () => {
    const status = readDoc(path.join("docs", "status.md"));

    it("documents the JSON envelope core keys", () => {
      for (const key of [
        "runnerProfile",
        "goalState",
        "artifacts",
        "currentIterationDetail",
        "nextActionDetail",
        "latestCommitSha",
        "daemon",
        "staleRecovery",
        "policy"
      ]) {
        expect(status).toContain(key);
      }
    });

    it("documents the reducer decision values", () => {
      for (const decision of [
        "continue",
        "goal_complete",
        "max_iterations_reached",
        "iteration_failed"
      ]) {
        expect(status).toContain(decision);
      }
    });

    it("documents the linked source items and latest evidence sub-blocks", () => {
      for (const key of [
        "sourceItems",
        "adapterKind",
        "externalKey",
        "lastObservedAt",
        "latestEvidence",
        "artifactPath",
        "sourceItemId"
      ]) {
        expect(status).toContain(key);
      }
    });

    it("documents the pending update intents block and stale threshold", () => {
      for (const key of [
        "pendingUpdateIntents",
        "intentId",
        "intentType",
        "targetExternalId",
        "intentStaleThresholdMs"
      ]) {
        expect(status).toContain(key);
      }
    });

    it("documents the daemon and staleRecovery sub-blocks", () => {
      for (const key of [
        "isActive",
        "isTerminal",
        "stopRequest",
        "stopNowRequest",
        "cancelOutcome",
        "recoveredRepoLockCount",
        "staleLeaseGraceMs"
      ]) {
        expect(status).toContain(key);
      }
    });

    it("documents the policy block, recoveryMd artifact, and no_goals failure code", () => {
      expect(status).toContain("MOMENTUM.md");
      expect(status).toContain("hasNotes");
      expect(status).toContain("recoveryMd");
      expect(status).toContain("no_goals");
    });
  });

  describe("docs/intent-commands.md", () => {
    const intentCommands = readDoc(path.join("docs", "intent-commands.md"));

    it("covers all five intent commands", () => {
      for (const cmd of [
        "intent list",
        "intent get",
        "intent apply",
        "intent skip",
        "intent cancel"
      ]) {
        expect(intentCommands).toContain(cmd);
      }
    });

    it("documents intent list filters and JSON envelope keys", () => {
      for (const key of [
        "--status",
        "--adapter",
        "--type",
        "--goal",
        "--source-item",
        "--evidence-record",
        "--limit",
        "adapterKind",
        "targetExternalId",
        "intentType",
        "idempotencyKey",
        "decisionReason"
      ]) {
        expect(intentCommands).toContain(key);
      }
    });

    it("documents the four intent status values", () => {
      for (const status of ["pending", "applied", "skipped", "canceled"]) {
        expect(intentCommands).toContain(status);
      }
    });

    it("documents intent_not_found and intent_already_terminal refusal codes", () => {
      expect(intentCommands).toContain("intent_not_found");
      expect(intentCommands).toContain("intent_already_terminal");
      expect(intentCommands).toContain("currentStatus");
    });

    it("documents the intent apply policy resolution and external-apply refusal codes", () => {
      expect(intentCommands).toContain("MOMENTUM.md");
      expect(intentCommands).toContain("intent_apply_policy");
      expect(intentCommands).toContain("create_intents_only");
      expect(intentCommands).toContain("external_apply_allowed");
      expect(intentCommands).toContain("--external-apply");
      expect(intentCommands).toContain("policy_denied");
      expect(intentCommands).toContain("auth_unavailable");
      expect(intentCommands).toContain("intent_apply_in_progress");
      expect(intentCommands).toContain("intent_blocked");
      expect(intentCommands).toContain("audit_incomplete");
    });

    it("documents the applyPolicy block fields surfaced on --external-apply", () => {
      for (const key of [
        "applyPolicy",
        "effective",
        "externalApplyRequested",
        "externalApplyPerformed",
        "previousStatus"
      ]) {
        expect(intentCommands).toContain(key);
      }
    });

    it("documents the required --reason flag on apply / skip / cancel", () => {
      expect(intentCommands).toMatch(/--reason/);
    });
  });

  describe("docs/doctor.md", () => {
    const doctor = readDoc(path.join("docs", "doctor.md"));

    it("documents the daemon-readiness JSON envelope fields", () => {
      for (const key of [
        "ok",
        "dataDir",
        "hasRun",
        "isActive",
        "stale",
        "staleRunCount",
        "staleRepoLockCount",
        "staleClaimedJobCount",
        "goalsNeedingRecoveryCount",
        "runId"
      ]) {
        expect(doctor).toContain(key);
      }
    });

    it("documents the runners block (supported, default, profiles, executes)", () => {
      for (const key of [
        "supported",
        "default",
        "profiles",
        "fake",
        "trusted-shell",
        "acp",
        "executes"
      ]) {
        expect(doctor).toContain(key);
      }
      expect(doctor).toContain("runtime_unavailable");
    });

    it("documents the policy block (MOMENTUM.md, error code taxonomy)", () => {
      expect(doctor).toContain("MOMENTUM.md");
      for (const key of [
        "repoConfigured",
        "repoPath",
        "hasNotes",
        "policy_path_invalid",
        "policy_file_unreadable",
        "policy_parse_invalid",
        "policy_schema_invalid"
      ]) {
        expect(doctor).toContain(key);
      }
    });

    it("documents the effectiveIntentApply block (default + override + sources)", () => {
      for (const key of [
        "effectiveIntentApply",
        "create_intents_only",
        "external_apply_allowed",
        "builtin_default",
        "momentum_policy"
      ]) {
        expect(doctor).toContain(key);
      }
    });

    it("documents the sources block (counts and lastReconciliation)", () => {
      for (const key of [
        "totalSourceItems",
        "linkedSourceItems",
        "unlinkedSourceItems",
        "lastReconciliation",
        "adapterKind",
        "itemsSeen",
        "itemsUpserted",
        "paginationStopped"
      ]) {
        expect(doctor).toContain(key);
      }
    });

    it("documents the evidence block (counts and lastRecord)", () => {
      for (const key of [
        "totalRecords",
        "goalLinkedRecords",
        "sourceItemLinkedRecords",
        "lastRecord"
      ]) {
        expect(doctor).toContain(key);
      }
    });
  });

  describe("docs/worker-run.md", () => {
    const workerRun = readDoc(path.join("docs", "worker-run.md"));

    it("documents the single-job claim pipeline (claim, lock, heartbeat, finalize)", () => {
      expect(workerRun).toContain("worker run");
      expect(workerRun).toContain("goal_iteration");
      expect(workerRun).toMatch(/claim/i);
      expect(workerRun).toMatch(/heartbeat/i);
      expect(workerRun).toContain("finalizeIteration");
      expect(workerRun).toContain("baseHead");
    });

    it("documents the result_path / error_path artifact pointers persisted on the job", () => {
      expect(workerRun).toContain("result_path");
      expect(workerRun).toContain("error_path");
      expect(workerRun).toContain("verification.log");
      expect(workerRun).toContain("runner.log");
    });

    it("documents the job.succeeded / job.failed event surfaces and artifact pointers", () => {
      for (const key of [
        "job.succeeded",
        "job.failed",
        "commit_sha",
        "branch",
        "base_head",
        "goal_complete",
        "iteration_dir",
        "result_json"
      ]) {
        expect(workerRun).toContain(key);
      }
    });

    it("enumerates the four reducer outcomes and the idempotency short-circuit", () => {
      for (const outcome of [
        "continue",
        "goal_complete",
        "max_iterations_reached",
        "iteration_failed",
        "already_reduced"
      ]) {
        expect(workerRun).toContain(outcome);
      }
      expect(workerRun).toContain("goal.reduced");
      expect(workerRun).toContain("goal.completed");
      expect(workerRun).toContain("goal.failed");
      expect(workerRun).toContain("goal.reduce_failed");
      expect(workerRun).toContain("reducerError");
    });

    it("documents the RunnerAdapter dispatch and executes:true gate", () => {
      expect(workerRun).toContain("RunnerAdapter");
      expect(workerRun).toContain("executes: true");
      expect(workerRun).toContain("trusted-shell");
      expect(workerRun).toContain("acp");
    });

    it("documents the stalePreCheck pre-claim surface", () => {
      expect(workerRun).toContain("stalePreCheck");
      expect(workerRun).toContain("staleLeaseGraceMs");
    });

    it("documents the CLI JSON result codes (no_work, not_executed, ran_job)", () => {
      for (const code of ["no_work", "not_executed", "ran_job"]) {
        expect(workerRun).toContain(code);
      }
    });

    it("documents the local interrupt policy and recovery_status lock release", () => {
      expect(workerRun).toMatch(/interrupt/i);
      expect(workerRun).toContain("recovery_status");
      expect(workerRun).toContain("needs_manual_recovery");
    });
  });

  describe("docs/daemon.md", () => {
    const daemon = readDoc(path.join("docs", "daemon.md"));

    it("documents daemon start register-only and managed-loop modes", () => {
      expect(daemon).toContain("daemon start");
      expect(daemon).toMatch(/register-only/i);
      expect(daemon).toMatch(/managed loop/i);
      expect(daemon).toContain("--max-loop-iterations");
      expect(daemon).toContain("--max-idle-cycles");
      expect(daemon).toContain("--poll-interval-ms");
    });

    it("documents the daemon_already_active concurrency guard surfaces", () => {
      expect(daemon).toContain("daemon_already_active");
      for (const key of [
        "runId",
        "pid",
        "host",
        "heartbeatAgeMs",
        "stale"
      ]) {
        expect(daemon).toContain(key);
      }
    });

    it("enumerates the managed-loop exitReason values", () => {
      for (const reason of [
        "stop_requested",
        "stop_now_requested",
        "run_terminated",
        "run_missing",
        "max_loop_iterations",
        "max_idle_cycles",
        "internal_error"
      ]) {
        expect(daemon).toContain(reason);
      }
    });

    it("documents the daemon stop graceful vs stop-now semantics", () => {
      expect(daemon).toContain("daemon stop");
      expect(daemon).toContain("--now");
      expect(daemon).toContain("operator-requested");
      expect(daemon).toContain("alreadyStopRequested");
      expect(daemon).toContain("alreadyStopNow");
      expect(daemon).toContain("stopNowRequestedAt");
      expect(daemon).toContain("no_active_daemon");
    });

    it("documents the daemon status read-only inspector surface", () => {
      expect(daemon).toContain("daemon status");
      for (const key of [
        "isActive",
        "isTerminal",
        "staleAfterMs",
        "activeJobStaleAfterMs",
        "staleLeaseGraceMs",
        "staleRepoLocks",
        "staleClaimedJobs",
        "goalsNeedingRecovery"
      ]) {
        expect(daemon).toContain(key);
      }
    });

    it("documents the startup-recovery summary fields on the managed loop response", () => {
      expect(daemon).toContain("startupRecovery");
      for (const key of [
        "recoveredRepoLockCount",
        "recoveredClaimedJobCount",
        "recoveredDaemonRunCount",
        "skippedRepoLocks",
        "skippedClaimedJobs",
        "skippedDaemonRuns"
      ]) {
        expect(daemon).toContain(key);
      }
    });
  });

  describe("docs/goal-start.md", () => {
    const goalStart = readDoc(path.join("docs", "goal-start.md"));

    it("documents both queued and foreground modes", () => {
      expect(goalStart).toMatch(/queued/i);
      expect(goalStart).toMatch(/foreground/i);
      expect(goalStart).toContain("--foreground");
    });

    it("documents the queued JSON envelope shape (goalId, jobId, idempotencyKey, enqueueCreated)", () => {
      for (const key of [
        "goalId",
        "jobId",
        "goal_iteration",
        "idempotencyKey",
        "enqueueCreated",
        "runnerProfile",
        "runnerProfileSource"
      ]) {
        expect(goalStart).toContain(key);
      }
    });

    it("documents the foreground JSON envelope shape (iteration block, commitSha, baseHead)", () => {
      for (const key of [
        "foreground_iteration",
        "iteration_complete",
        "commitSha",
        "baseHead",
        "promptPath",
        "verificationLogPath"
      ]) {
        expect(goalStart).toContain(key);
      }
    });

    it("documents the policy block (MOMENTUM.md summary, effective precedence)", () => {
      expect(goalStart).toContain("policyNotes");
      expect(goalStart).toContain("effective");
      expect(goalStart).toContain("MOMENTUM.md");
    });

    it("documents the init-time validation codes", () => {
      for (const code of [
        "parse_error",
        "unsupported_runner",
        "malformed_profile",
        "source_item_not_found",
        "goal_not_found",
        "linked_to_other_goal",
        "link_changed",
        "init_failed"
      ]) {
        expect(goalStart).toContain(code);
      }
    });

    it("documents the resume / idempotency behavior", () => {
      expect(goalStart).toMatch(/resumed/i);
      expect(goalStart).toMatch(/Goal resumed/);
    });
  });

  describe("docs/runners.md", () => {
    const runners = readDoc(path.join("docs", "runners.md"));

    it("covers trusted-shell, acp, and MOMENTUM.md policy", () => {
      expect(runners).toContain("trusted-shell");
      expect(runners).toContain("acp");
      expect(runners).toContain("MOMENTUM.md");
    });

    it("preserves the Repo policy via MOMENTUM.md anchor heading", () => {
      expect(runners).toMatch(/Repo policy via MOMENTUM\.md/);
    });

    it("documents the precedence chain (CLI > frontmatter > MOMENTUM.md > built-in)", () => {
      expect(runners).toMatch(/CLI[^\n]*frontmatter[^\n]*MOMENTUM\.md/i);
    });
  });

  describe("docs/recovery.md", () => {
    const recovery = readDoc(path.join("docs", "recovery.md"));

    it("documents the stale-lease auto-recovery surfaces", () => {
      expect(recovery).toMatch(/stale-?lease/i);
      for (const surface of ["repo_locks", "goal_iteration", "daemon_runs"]) {
        expect(recovery).toContain(surface);
      }
    });

    it("documents the stale-claim skip taxonomy", () => {
      for (const reason of [
        "repo_dirty",
        "repo_unknown_commit",
        "repo_unavailable",
        "job_running",
        "daemon_active",
        "lock_active"
      ]) {
        expect(recovery).toContain(reason);
      }
    });

    it("documents the manual recovery artifact and durable flag", () => {
      expect(recovery).toContain("recovery.md");
      expect(recovery).toContain("needs_manual_recovery");
      expect(recovery).toMatch(/runner_changed_head/);
      expect(recovery).toMatch(/head_mismatch/);
    });

    it("documents the recovery clear operator path", () => {
      expect(recovery).toMatch(/recovery clear/);
      expect(recovery).toMatch(/goal\.recovery_cleared/);
    });

    it("documents the recovery clear JSON success envelope shape", () => {
      for (const key of [
        "previousReason",
        "previousMarkedAt",
        "clearedAt",
        "eventId",
        "releasedRepoLockIds"
      ]) {
        expect(recovery).toContain(key);
      }
    });

    it("documents the recovery clear refusal codes (goal_not_found, not_flagged, job_active)", () => {
      for (const code of ["goal_not_found", "not_flagged", "job_active", "activeJobIds"]) {
        expect(recovery).toContain(code);
      }
    });
  });

  describe("docs/walkthrough.md", () => {
    const walkthrough = readDoc(path.join("docs", "walkthrough.md"));

    it("documents the queued default path (goal start, worker run, status / logs / handoff)", () => {
      expect(walkthrough).toMatch(/queued/i);
      expect(walkthrough).toContain("goal start");
      expect(walkthrough).toContain("worker run");
      expect(walkthrough).toContain("status");
      expect(walkthrough).toContain("logs");
      expect(walkthrough).toContain("handoff");
    });

    it("documents the managed daemon drain alternative", () => {
      expect(walkthrough).toMatch(/Managed daemon drain/i);
      expect(walkthrough).toContain("daemon start");
      expect(walkthrough).toContain("--max-idle-cycles");
      expect(walkthrough).toContain("daemon_runs");
    });

    it("documents the failure-reset path and verification.log artifact", () => {
      expect(walkthrough).toMatch(/verification: \["false"\]/);
      expect(walkthrough).toContain("verification.log");
      expect(walkthrough).toMatch(/errorPath/);
    });

    it("documents the foreground debug path as an inline debugging escape hatch", () => {
      expect(walkthrough).toMatch(/Foreground debug path/i);
      expect(walkthrough).toContain("--foreground");
    });
  });

  describe("docs/failure-reset.md", () => {
    const failureReset = readDoc(path.join("docs", "failure-reset.md"));

    it("documents the baseHead transaction model and per-iteration outcome set", () => {
      expect(failureReset).toContain("baseHead");
      expect(failureReset).toMatch(/transaction/i);
    });

    it("enumerates the six iteration outcomes (committed, reset_runner_failure, reset_verification_failure, commit_failed, reset_failed, manual_recovery)", () => {
      for (const outcome of [
        "committed",
        "reset_runner_failure",
        "reset_verification_failure",
        "commit_failed",
        "reset_failed",
        "manual_recovery"
      ]) {
        expect(failureReset).toContain(outcome);
      }
    });

    it("documents the runner failure code taxonomy (runner_reported_failure, command_failed, output_overflow, result_missing, result_invalid)", () => {
      for (const code of [
        "runner_reported_failure",
        "command_failed",
        "command_timed_out",
        "spawn_failed",
        "output_overflow",
        "result_missing",
        "result_invalid"
      ]) {
        expect(failureReset).toContain(code);
      }
    });

    it("documents the manual-recovery reasons (runner_changed_head, head_mismatch)", () => {
      expect(failureReset).toContain("runner_changed_head");
      expect(failureReset).toContain("head_mismatch");
    });

    it("documents the early-pipeline error codes (invalid_input, missing_repo, unsupported_runner, repo_guard_failed, branch_manager_failed, artifact_write_failed, git_failed, unexpected_error)", () => {
      for (const code of [
        "invalid_input",
        "missing_repo",
        "unsupported_runner",
        "repo_guard_failed",
        "branch_manager_failed",
        "artifact_write_failed",
        "git_failed",
        "unexpected_error"
      ]) {
        expect(failureReset).toContain(code);
      }
    });

    it("documents the verification.log capture with [verify] prefix and capped buffer", () => {
      expect(failureReset).toContain("verification.log");
      expect(failureReset).toMatch(/\[verify\]/);
      expect(failureReset).toMatch(/cap/i);
    });
  });

  describe("README.md concise OSS front door", () => {
    const readme = readDoc("README.md");

    it("stays short enough to work as an OSS front door", () => {
      const lines = readme.trimEnd().split(/\n/);
      expect(
        lines.length,
        `README.md should stay concise; move reference material to docs/index.md (was ${lines.length} lines)`
      ).toBeLessThanOrEqual(120);
    });

    it("does not expose an exhaustive documentation index", () => {
      expect(readme).not.toContain("## Documentation");
      expect(readme).not.toContain("Command envelopes:");
      expect(readme).not.toContain("Operator references:");
      expect(readme).not.toContain("Cross-cutting contracts:");
    });

    it("keeps detailed docs behind one docs front-door link", () => {
      expect(readme).toContain("https://calvinnwq.github.io/momentum/");
      expect(readme).toMatch(/docs\/index\.md/);
      const docsLinks = new Set(readme.match(/docs\/[A-Za-z0-9./_-]+\.md/g) ?? []);
      expect(Array.from(docsLinks).sort()).toEqual(["docs/index.md"]);
    });

    it("removes badges for metadata that is not present", () => {
      expect(readme).not.toMatch(/shields\.io\/badge\/license/i);
      expect(readme).not.toMatch(/shields\.io\/npm/i);
      expect(readme).not.toMatch(/github\/actions/i);
    });

    it("keeps command surface as a compact overview rather than per-command reference", () => {
      const commandsStart = readme.indexOf("## Commands");
      const developmentStart = readme.indexOf("## Development");
      expect(commandsStart, "## Commands section should exist").toBeGreaterThanOrEqual(0);
      expect(developmentStart, "## Development should follow ## Commands").toBeGreaterThan(commandsStart);
      const commands = readme.slice(commandsStart, developmentStart);
      expect(commands).not.toMatch(/^### /m);
      expect(commands.length, `## Commands should stay compact (was ${commands.length} chars)`).toBeLessThan(1600);
    });
  });

  describe("docs/index.md GitHub Pages front door", () => {
    const docsIndex = readDoc("docs/index.md");

    it("exists as the simple GitHub Pages documentation entrypoint", () => {
      expect(docsIndex).toMatch(/^# Momentum Documentation/m);
    });

    it("links to the command and concept pages", () => {
      for (const link of [
        "goal-spec.md",
        "data-directory.md",
        "walkthrough.md",
        "goal-start.md",
        "status.md",
        "logs.md",
        "handoff.md",
        "worker-run.md",
        "daemon.md",
        "recovery.md",
        "source-commands.md",
        "evidence-commands.md",
        "intent-commands.md",
        "doctor.md",
        "runners.md",
        "failure-reset.md",
      ]) {
        expect(docsIndex).toContain(link);
      }
    });
  });

  describe("docs/data-directory.md artifact layout reference", () => {
    const dataDir = readDoc("docs/data-directory.md");

    it("documents the data-directory resolution chain (--data-dir > MOMENTUM_HOME > ~/.momentum)", () => {
      expect(dataDir).toContain("--data-dir");
      expect(dataDir).toContain("MOMENTUM_HOME");
      expect(dataDir).toContain("~/.momentum");
    });

    it("documents the SQLite tables that live under momentum.db", () => {
      expect(dataDir).toContain("momentum.db");
      expect(dataDir).toContain("goals");
      expect(dataDir).toContain("jobs");
      expect(dataDir).toContain("events");
      expect(dataDir).toContain("repo_locks");
      expect(dataDir).toContain("daemon_runs");
      expect(dataDir).toContain("source_items");
      expect(dataDir).toContain("source_snapshots");
      expect(dataDir).toContain("source_reconciliation_runs");
      expect(dataDir).toContain("evidence_records");
      expect(dataDir).toContain("update_intents");
    });

    it("documents the per-goal artifact files (goal.md, ledger.md, handoff.md, handoff.json, recovery.md)", () => {
      expect(dataDir).toContain("goal.md");
      expect(dataDir).toContain("ledger.md");
      expect(dataDir).toContain("handoff.md");
      expect(dataDir).toContain("handoff.json");
      expect(dataDir).toContain("recovery.md");
    });

    it("documents the per-iteration artifact files (prompt.md, runner.log, verification.log, result.json)", () => {
      expect(dataDir).toContain("prompt.md");
      expect(dataDir).toContain("runner.log");
      expect(dataDir).toContain("verification.log");
      expect(dataDir).toContain("result.json");
    });

    it("documents the initialization lifecycle (placeholders vs queued worker run vs foreground)", () => {
      expect(dataDir).toMatch(/placeholder|empty/i);
      expect(dataDir).toContain("{}");
      expect(dataDir).toMatch(/foreground/i);
      expect(dataDir).toMatch(/worker run|queued/i);
    });

    it("notes that goals share one SQLite database but isolated artifact trees", () => {
      expect(dataDir).toMatch(/share[^\n]*SQLite|same SQLite/i);
      expect(dataDir).toMatch(/isolated|per-goal/i);
    });

    it("notes that trusted-shell / acp may report another result file in the iteration directory", () => {
      expect(dataDir).toContain("trusted-shell");
      expect(dataDir).toContain("acp");
    });
  });

  describe("docs/goal-spec.md goal frontmatter reference", () => {
    const goalSpec = readDoc("docs/goal-spec.md");

    it("documents the required title and optional frontmatter fields", () => {
      expect(goalSpec).toContain("title");
      expect(goalSpec).toContain("repo");
      expect(goalSpec).toContain("runner");
      expect(goalSpec).toContain("branch");
      expect(goalSpec).toContain("max_iterations");
      expect(goalSpec).toContain("verification");
      expect(goalSpec).toContain("verification_timeout_sec");
      expect(goalSpec).toContain("trusted_shell");
      expect(goalSpec).toContain("acp");
    });

    it("documents the built-in defaults", () => {
      expect(goalSpec).toContain("runner: fake");
      expect(goalSpec).toContain("momentum/<title-slug>");
      expect(goalSpec).toContain("max_iterations: 1");
      expect(goalSpec).toContain("verification: []");
      expect(goalSpec).toContain("verification_timeout_sec: 900");
    });

    it("documents the strict-type validation rules and accepted runner names", () => {
      expect(goalSpec).toMatch(/positive integer/);
      expect(goalSpec).toContain("fake");
      expect(goalSpec).toContain("trusted-shell");
      expect(goalSpec).toContain("acp");
      expect(goalSpec).toMatch(/rejected at init time|init time/i);
    });

    it("documents the runner precedence chain (CLI > frontmatter > MOMENTUM.md > built-in)", () => {
      expect(goalSpec).toMatch(/--runner[^\n]*frontmatter[^\n]*MOMENTUM\.md/);
      expect(goalSpec).toContain("MOMENTUM.md");
    });

    it("documents the relative-repo absolute resolution in the queued path", () => {
      expect(goalSpec).toMatch(/relative.*repo.*absolute|absolute.*before.*persisted|resolved to absolute/i);
    });
  });

  describe("AGENTS.md compact agent contract", () => {
    const agents = readDoc("AGENTS.md");

    it("names the active milestone (M6)", () => {
      expect(agents).toMatch(/Milestone 6/);
    });

    it("points future agents to internal/ for planning context", () => {
      expect(agents).toMatch(/internal\/(roadmap|milestones|contracts)/);
    });

    it("stays compact (under 200 lines)", () => {
      const lineCount = agents.split("\n").length;
      expect(lineCount, `AGENTS.md should be compact, was ${lineCount} lines`).toBeLessThan(200);
    });

    it("declares the docs/ vs internal/ split explicitly", () => {
      expect(agents).toMatch(/Where docs live/i);
      expect(agents).toContain("internal/");
      expect(agents).toContain("docs/");
    });

    it("Data and artifact layout section points to docs/data-directory.md and stays compact", () => {
      const start = agents.indexOf("## Data and artifact layout");
      expect(start, "AGENTS.md should still declare a ## Data and artifact layout section").toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/docs\/data-directory\.md/);
      expect(
        section.length,
        `## Data and artifact layout section should be compact (was ${section.length} chars)`
      ).toBeLessThan(700);
    });

    it("CLI expectations section points to README/docs and preserves the operational-safety bullets", () => {
      const start = agents.indexOf("## CLI expectations");
      expect(start, "AGENTS.md should still declare a ## CLI expectations section").toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/README\.md/);
      expect(section).toMatch(/docs\//);
      for (const cmd of ["`daemon start`", "`daemon stop`", "`daemon status`", "`recovery clear`", "`doctor`"]) {
        expect(section, `## CLI expectations should preserve the bullet ${cmd}`).toContain(cmd);
      }
      expect(
        section.length,
        `## CLI expectations section should be compact (was ${section.length} chars)`
      ).toBeLessThan(800);
    });

    it("Stack and workflow commands section points to README and stays compact", () => {
      const start = agents.indexOf("## Stack and workflow commands");
      expect(start, "AGENTS.md should declare a ## Stack and workflow commands section").toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/README\.md/);
      for (const tech of ["TypeScript", "Node.js", "Vitest", "pnpm"]) {
        expect(section, `## Stack and workflow commands should still name ${tech}`).toContain(tech);
      }
      expect(
        section.length,
        `## Stack and workflow commands section should be compact (was ${section.length} chars)`
      ).toBeLessThan(400);
    });

    it("Current milestone section links to internal/ docs and stays compact", () => {
      const start = agents.indexOf("## Current milestone");
      expect(start, "AGENTS.md should declare a ## Current milestone section").toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/internal\/roadmap\.md/);
      expect(section).toMatch(/internal\/milestones\/m6-external-apply\.md/);
      expect(
        section.length,
        `## Current milestone section should be compact (was ${section.length} chars)`
      ).toBeLessThan(2500);
    });

    it("agent operating-instruction sections stay compact", () => {
      const operatingSectionBudgets: Array<{ heading: string; maxChars: number }> = [
        { heading: "## Project purpose", maxChars: 500 },
        { heading: "## Coding discipline", maxChars: 500 },
        { heading: "## Local agent run artifacts", maxChars: 500 },
        { heading: "## Verification before completion", maxChars: 500 },
      ];

      for (const { heading, maxChars } of operatingSectionBudgets) {
        const start = agents.indexOf(heading);
        expect(start, `AGENTS.md should declare a ${heading} section`).toBeGreaterThan(-1);
        const end = agents.indexOf("\n## ", start + 1);
        const section = agents.slice(start, end > start ? end : undefined);
        expect(
          section.length,
          `${heading} section should stay compact (was ${section.length} chars)`
        ).toBeLessThan(maxChars);
      }
    });
  });

  describe("docs link integrity", () => {
    const sources: { file: string }[] = [{ file: "README.md" }, { file: "AGENTS.md" }];
    for (const { file } of sources) {
      it(`every docs/*.md link in ${file} targets a file that exists`, () => {
        const body = readDoc(file);
        const matches = body.match(/docs\/[A-Za-z0-9./_-]+\.md/g) ?? [];
        const unique = Array.from(new Set(matches));
        expect(
          unique.length,
          `${file} should reference at least one docs/*.md page`
        ).toBeGreaterThan(0);
        const missing: string[] = [];
        for (const relPath of unique) {
          if (!fs.existsSync(path.join(repoRoot, relPath))) {
            missing.push(relPath);
          }
        }
        expect(
          missing,
          `${file} references docs/*.md paths that do not exist on disk: ${missing.join(", ")}`
        ).toEqual([]);
      });
    }

    it("every docs/*.md file on disk is linked from docs/index.md", () => {
      const docsDir = path.join(repoRoot, "docs");
      const allDocs: string[] = [];
      function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            allDocs.push(path.relative(repoRoot, full).split(path.sep).join("/"));
          }
        }
      }
      walk(docsDir);
      expect(allDocs.length, "docs/ should contain at least one *.md file").toBeGreaterThan(0);

      const docsIndex = readDoc("docs/index.md");
      const matches = docsIndex.match(/(?:\.\/)?(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md/g) ?? [];
      const linked = new Set(
        matches.map((match) => path.join("docs", match.replace(/^\.\//, "")).split(path.sep).join("/"))
      );

      const orphans = allDocs.filter((doc) => doc !== "docs/index.md" && !linked.has(doc));
      expect(
        orphans,
        `docs/index.md should link to every docs/*.md page so each is reachable from the docs front door (orphans: ${orphans.join(", ")})`
      ).toEqual([]);
    });

    it("every relative .md link inside docs/*.md targets a file that exists", () => {
      const docsDir = path.join(repoRoot, "docs");
      const allDocs: string[] = [];
      function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            allDocs.push(full);
          }
        }
      }
      walk(docsDir);
      expect(
        allDocs.length,
        "docs/ should contain at least one *.md file"
      ).toBeGreaterThan(0);

      const broken: string[] = [];
      const linkRe = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;
      for (const docPath of allDocs) {
        const body = fs.readFileSync(docPath, "utf8");
        const sourceDir = path.dirname(docPath);
        const relSource = path
          .relative(repoRoot, docPath)
          .split(path.sep)
          .join("/");
        let match: RegExpExecArray | null;
        while ((match = linkRe.exec(body)) !== null) {
          const target = match[1]!;
          if (/^https?:/i.test(target)) continue;
          if (target.startsWith("#")) continue;
          const resolved = path.resolve(sourceDir, target);
          if (!fs.existsSync(resolved)) {
            const relResolved = path
              .relative(repoRoot, resolved)
              .split(path.sep)
              .join("/");
            broken.push(`${relSource} -> ${target} (resolves to ${relResolved})`);
          }
        }
      }
      expect(
        broken,
        `docs/*.md files contain markdown links to .md targets that do not exist on disk: ${broken.join("; ")}`
      ).toEqual([]);
    });

    it("every #anchor in markdown links across docs/, README, and AGENTS resolves to a heading in the target file", () => {
      const docsDir = path.join(repoRoot, "docs");
      const allSources: string[] = [];
      function walk(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            allSources.push(full);
          }
        }
      }
      walk(docsDir);
      allSources.push(path.join(repoRoot, "README.md"));
      allSources.push(path.join(repoRoot, "AGENTS.md"));

      function slugify(heading: string): string {
        return heading
          .toLowerCase()
          .replace(/[^a-z0-9 \-]/g, "")
          .trim()
          .replace(/\s+/g, "-");
      }

      function headingSlugsOf(body: string): Set<string> {
        const slugs = new Set<string>();
        const re = /^#{1,6}\s+(.+?)\s*$/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
          slugs.add(slugify(m[1]!));
        }
        return slugs;
      }

      const broken: string[] = [];
      const anchorLinkRe = /\]\(([^)\s#]+\.md)#([^)\s]+)\)/g;
      for (const sourcePath of allSources) {
        const body = fs.readFileSync(sourcePath, "utf8");
        const sourceDir = path.dirname(sourcePath);
        const relSource = path
          .relative(repoRoot, sourcePath)
          .split(path.sep)
          .join("/");
        let match: RegExpExecArray | null;
        while ((match = anchorLinkRe.exec(body)) !== null) {
          const target = match[1]!;
          const anchor = match[2]!;
          if (/^https?:/i.test(target)) continue;
          const resolved = path.resolve(sourceDir, target);
          if (!fs.existsSync(resolved)) continue;
          const targetBody = fs.readFileSync(resolved, "utf8");
          const slugs = headingSlugsOf(targetBody);
          if (!slugs.has(anchor)) {
            const relResolved = path
              .relative(repoRoot, resolved)
              .split(path.sep)
              .join("/");
            broken.push(`${relSource} -> ${relResolved}#${anchor}`);
          }
        }
      }
      expect(
        broken,
        `markdown links contain #anchor suffixes that do not match any heading in the target file: ${broken.join("; ")}`
      ).toEqual([]);
    });
  });

  it("pins the doctor milestone string to the M6 closeout marker (NGX-302)", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).toContain(
      "Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete"
    );
    expect(cli).not.toContain(
      "Milestone 5: source adapters and evidence sync (NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294) complete"
    );
  });
});
