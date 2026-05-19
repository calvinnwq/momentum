import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

const M6_ISSUE_ORDER = [
  "NGX-295",
  "NGX-296",
  "NGX-297",
  "NGX-299",
  "NGX-298",
  "NGX-300",
  "NGX-301",
  "NGX-302"
] as const;

const M6_INVARIANTS = [
  "audit-before-apply",
  "two-phase",
  "blocked",
  "intent_apply_in_progress",
  "comment-only",
  "idempotency marker",
  "single-issue reconcile",
  "api.linear.app"
] as const;

const M6_API_LINEAR_NEGATION = /(must not|never|no).*api\.linear\.app|api\.linear\.app.*(must not|never|no)/i;

describe("M6 contract docs (NGX-295 setup)", () => {
  describe("docs directory structure", () => {
    it("has docs/roadmap.md", () => {
      const p = path.join(repoRoot, "docs", "roadmap.md");
      expect(fs.existsSync(p), "docs/roadmap.md should exist").toBe(true);
    });

    it("has docs/milestones/m5-source-adapters.md", () => {
      const p = path.join(repoRoot, "docs", "milestones", "m5-source-adapters.md");
      expect(fs.existsSync(p), "docs/milestones/m5-source-adapters.md should exist").toBe(true);
    });

    it("has docs/milestones/m6-external-apply.md", () => {
      const p = path.join(repoRoot, "docs", "milestones", "m6-external-apply.md");
      expect(fs.existsSync(p), "docs/milestones/m6-external-apply.md should exist").toBe(true);
    });

    it("has docs/contracts/intent-apply.md", () => {
      const p = path.join(repoRoot, "docs", "contracts", "intent-apply.md");
      expect(fs.existsSync(p), "docs/contracts/intent-apply.md should exist").toBe(true);
    });

    it("has docs/contracts/source-adapters.md", () => {
      const p = path.join(repoRoot, "docs", "contracts", "source-adapters.md");
      expect(fs.existsSync(p), "docs/contracts/source-adapters.md should exist").toBe(true);
    });

    it("has docs/runners.md (extracted runner / policy spec)", () => {
      const p = path.join(repoRoot, "docs", "runners.md");
      expect(fs.existsSync(p), "docs/runners.md should exist").toBe(true);
    });

    it("has docs/recovery.md (extracted stale-lease + manual recovery spec)", () => {
      const p = path.join(repoRoot, "docs", "recovery.md");
      expect(fs.existsSync(p), "docs/recovery.md should exist").toBe(true);
    });

    it("has docs/exclusions.md (extracted current-exclusions / deferred-features spec)", () => {
      const p = path.join(repoRoot, "docs", "exclusions.md");
      expect(fs.existsSync(p), "docs/exclusions.md should exist").toBe(true);
    });

    it("has docs/walkthrough.md (extracted end-to-end walkthrough spec)", () => {
      const p = path.join(repoRoot, "docs", "walkthrough.md");
      expect(fs.existsSync(p), "docs/walkthrough.md should exist").toBe(true);
    });

    it("has docs/failure-reset.md (extracted failure and reset semantics spec)", () => {
      const p = path.join(repoRoot, "docs", "failure-reset.md");
      expect(fs.existsSync(p), "docs/failure-reset.md should exist").toBe(true);
    });

    it("has docs/goal-start.md (extracted goal start envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "goal-start.md");
      expect(fs.existsSync(p), "docs/goal-start.md should exist").toBe(true);
    });

    it("has docs/daemon.md (extracted daemon start / stop / status envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "daemon.md");
      expect(fs.existsSync(p), "docs/daemon.md should exist").toBe(true);
    });

    it("has docs/worker-run.md (extracted worker run pipeline spec)", () => {
      const p = path.join(repoRoot, "docs", "worker-run.md");
      expect(fs.existsSync(p), "docs/worker-run.md should exist").toBe(true);
    });

    it("has docs/doctor.md (extracted doctor JSON envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "doctor.md");
      expect(fs.existsSync(p), "docs/doctor.md should exist").toBe(true);
    });

    it("has docs/status.md (extracted status JSON envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "status.md");
      expect(fs.existsSync(p), "docs/status.md should exist").toBe(true);
    });

    it("has docs/handoff.md (extracted handoff JSON envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "handoff.md");
      expect(fs.existsSync(p), "docs/handoff.md should exist").toBe(true);
    });

    it("has docs/source-commands.md (extracted source / project CLI envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "source-commands.md");
      expect(fs.existsSync(p), "docs/source-commands.md should exist").toBe(true);
    });

    it("has docs/evidence-commands.md (extracted evidence ingest / list CLI envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "evidence-commands.md");
      expect(fs.existsSync(p), "docs/evidence-commands.md should exist").toBe(true);
    });

    it("has docs/smoke-tests.md (extracted smoke test coverage map)", () => {
      const p = path.join(repoRoot, "docs", "smoke-tests.md");
      expect(fs.existsSync(p), "docs/smoke-tests.md should exist").toBe(true);
    });

    it("has docs/logs.md (extracted logs CLI envelope spec)", () => {
      const p = path.join(repoRoot, "docs", "logs.md");
      expect(fs.existsSync(p), "docs/logs.md should exist").toBe(true);
    });
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

  describe("docs/smoke-tests.md", () => {
    const smokeTests = readDoc(path.join("docs", "smoke-tests.md"));

    it("names the built-binary smoke entry point", () => {
      expect(smokeTests).toContain("test/smoke.test.ts");
      expect(smokeTests).toMatch(/pnpm build/);
      expect(smokeTests).toMatch(/disposable/);
    });

    it("documents the queued default and foreground enqueue paths", () => {
      for (const phrase of [
        "queued enqueue",
        "idempotent re-enqueue",
        "foreground success",
        "verification-failure reset"
      ]) {
        expect(smokeTests).toContain(phrase);
      }
    });

    it("documents the queued worker run and logs inspection coverage", () => {
      for (const phrase of [
        "worker run",
        "queued logs",
        "reducer event chains",
        "runner-failure"
      ]) {
        expect(smokeTests).toContain(phrase);
      }
    });

    it("documents the M3 daemon / recovery smoke surfaces", () => {
      for (const surface of [
        "daemon start",
        "daemon stop",
        "daemon status",
        "recovery clear",
        "managed drain",
        "graceful stop",
        "stop-now",
        "safe stale recovery",
        "manual recovery"
      ]) {
        expect(smokeTests).toContain(surface);
      }
    });

    it("documents the M4 real-runner smoke surfaces", () => {
      for (const surface of [
        "trusted-shell",
        "command_failed",
        "MOMENTUM.md",
        "acp",
        "runtime_unavailable"
      ]) {
        expect(smokeTests).toContain(surface);
      }
    });

    it("documents the M5 source / evidence / intent smoke surfaces", () => {
      for (const surface of [
        "doctor --json",
        "M5 closeout",
        "workflow evidence",
        "Linear reconciliation",
        "mock endpoint",
        "source_satisfied",
        "external-apply refusal",
        "project rollup"
      ]) {
        expect(smokeTests).toContain(surface);
      }
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

    it("documents the intent apply policy resolution and external-apply M5 refusal", () => {
      expect(intentCommands).toContain("MOMENTUM.md");
      expect(intentCommands).toContain("intent_apply_policy");
      expect(intentCommands).toContain("create_intents_only");
      expect(intentCommands).toContain("--external-apply");
      expect(intentCommands).toContain("external_apply_unsupported");
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

    it("documents the NGX-276 stalePreCheck pre-claim surface", () => {
      expect(workerRun).toContain("stalePreCheck");
      expect(workerRun).toContain("NGX-276");
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

    it("documents the stale-lease auto-recovery surfaces (NGX-276)", () => {
      expect(recovery).toContain("NGX-276");
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

    it("documents the manual recovery artifact and durable flag (NGX-277)", () => {
      expect(recovery).toContain("NGX-277");
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

  describe("docs/exclusions.md", () => {
    const exclusions = readDoc(path.join("docs", "exclusions.md"));

    it("documents the deferred background runner supervision exclusion", () => {
      expect(exclusions).toMatch(/Background runner supervision/);
      expect(exclusions).toMatch(/forking|daemonization|restart-on-crash/);
    });

    it("documents the deferred cooperative shutdown exclusion", () => {
      expect(exclusions).toMatch(/Cooperative shutdown|mid-job cancellation/i);
    });

    it("documents the deferred external tracker writes exclusion", () => {
      expect(exclusions).toMatch(/external tracker writes|external integrations/i);
      expect(exclusions).toMatch(/inbound webhooks/i);
    });

    it("documents the deferred dashboard / UI surface exclusion", () => {
      expect(exclusions).toMatch(/dashboard|UI surface/i);
    });

    it("documents the strong sandboxing exclusion (M4 runners are trusted, not sandboxed)", () => {
      expect(exclusions).toMatch(/Strong sandboxing/);
      expect(exclusions).toMatch(/trusted-shell/);
      expect(exclusions).toMatch(/acp/);
    });

    it("documents the worktree / remote-git / parallel-same-repo-goals exclusion", () => {
      expect(exclusions).toMatch(/[Ww]orktree/);
      expect(exclusions).toMatch(/remote git/i);
      expect(exclusions).toMatch(/parallel.*same-repo|same-repo.*parallel/i);
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

    it("documents the managed daemon drain alternative (M3)", () => {
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

    it("documents the foreground debug path as a Milestone 1 inline debugging escape hatch", () => {
      expect(walkthrough).toMatch(/Foreground debug path/i);
      expect(walkthrough).toContain("--foreground");
      expect(walkthrough).toMatch(/Milestone 1/);
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

  describe("docs/roadmap.md", () => {
    const roadmap = readDoc(path.join("docs", "roadmap.md"));

    it("names all milestones in order", () => {
      let cursor = -1;
      for (const m of [
        "Milestone 1",
        "Milestone 2",
        "Milestone 3",
        "Milestone 4",
        "Milestone 5",
        "Milestone 6"
      ]) {
        const next = roadmap.indexOf(m, cursor + 1);
        expect(next, `${m} should appear after the previous milestone`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("lists the planned M6 issue order matching the Linear milestone", () => {
      let cursor = -1;
      for (const id of M6_ISSUE_ORDER) {
        const next = roadmap.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M6 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });
  });

  describe("docs/milestones/m6-external-apply.md", () => {
    const m6 = readDoc(path.join("docs", "milestones", "m6-external-apply.md"));

    it("documents the planned M6 issue order verbatim", () => {
      let cursor = -1;
      for (const id of M6_ISSUE_ORDER) {
        const next = m6.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M6 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("requires NGX-299 audit surfaces before NGX-298 external apply", () => {
      const auditIdx = m6.indexOf("NGX-299");
      const applyIdx = m6.indexOf("NGX-298");
      expect(auditIdx, "NGX-299 should be mentioned").toBeGreaterThanOrEqual(0);
      expect(applyIdx, "NGX-298 should be mentioned").toBeGreaterThanOrEqual(0);
      expect(auditIdx, "NGX-299 should precede NGX-298 in the issue ordering").toBeLessThan(applyIdx);
    });

    it("names M6 explicit non-goals (no auto-apply outside policy, no inbound webhooks, no UI)", () => {
      expect(m6).toMatch(/non-goals?/i);
      for (const ng of [
        "Dashboard or UI surface",
        "Inbound webhooks",
        "Autonomous",
        "non-Linear adapters",
        "runner/sandbox"
      ]) {
        expect(m6).toContain(ng);
      }
    });

    it("references the intent-apply contract", () => {
      expect(m6).toMatch(/intent-apply/);
    });
  });

  describe("docs/contracts/intent-apply.md", () => {
    const intentApply = readDoc(path.join("docs", "contracts", "intent-apply.md"));

    it("captures the M6 safety invariants", () => {
      for (const term of M6_INVARIANTS) {
        expect(intentApply).toContain(term);
      }
    });

    it("documents the two-phase external apply flow (claim, audit-before-write, external write, finalize)", () => {
      expect(intentApply).toMatch(/claim/i);
      expect(intentApply).toMatch(/audit/i);
      expect(intentApply).toMatch(/external write/i);
      expect(intentApply).toMatch(/finalize/i);
    });

    it("documents the blocked / non-replay state after external-write-success + audit-finalize-failure", () => {
      expect(intentApply).toMatch(/blocked/i);
      expect(intentApply).toMatch(/non-replay/i);
    });

    it("documents the per-intent concurrency guard with a stable intent_apply_in_progress result", () => {
      expect(intentApply).toContain("intent_apply_in_progress");
      expect(intentApply).toMatch(/CAS|compare-and-swap|concurrency guard/i);
    });

    it("documents the comment-only default unless target status mutation is configured", () => {
      expect(intentApply).toContain("comment-only");
      expect(intentApply).toMatch(/Linear/);
    });

    it("documents the idempotency marker shape and dedupe role", () => {
      expect(intentApply).toContain("idempotency marker");
      expect(intentApply).toMatch(/dedupe|deduplication|reconcile/i);
    });

    it("documents single-issue post-apply reconcile scope", () => {
      expect(intentApply).toContain("single-issue reconcile");
    });

    it("documents the test guard against real api.linear.app calls", () => {
      expect(intentApply).toContain("api.linear.app");
      expect(intentApply).toMatch(M6_API_LINEAR_NEGATION);
    });
  });

  describe("docs/contracts/source-adapters.md", () => {
    const sources = readDoc(path.join("docs", "contracts", "source-adapters.md"));

    it("documents source adapter boundaries (read-only, durable local tables, no credentials in state)", () => {
      expect(sources).toMatch(/read-?only/i);
      expect(sources).toMatch(/snapshot|reconciliation|SourceItem/i);
      expect(sources).toMatch(/credential/i);
    });
  });

  describe("docs/milestones/m5-source-adapters.md", () => {
    const m5 = readDoc(path.join("docs", "milestones", "m5-source-adapters.md"));

    it("frames M5 as durable intents / source adapters, NOT external apply", () => {
      expect(m5).toMatch(/durable.*intent|intent.*durable/i);
      expect(m5).toMatch(/does not.*(external|automatic).*apply|no.*external.*write|policy-?gated/i);
    });

    it("does not claim external apply was implemented in M5", () => {
      expect(m5).not.toMatch(/M5 (added|implements|implemented|introduces|provides|performs) (an? )?external apply/i);
      expect(m5).not.toMatch(/external apply (was|landed|shipped|implemented) in M5/i);
    });
  });

  describe("README.md OSS-facing reshape", () => {
    const readme = readDoc("README.md");

    it("includes a compact shield block near the top (CI/Node/TypeScript/license)", () => {
      const header = readme.slice(0, 4000);
      expect(header).toMatch(/!\[.*\]\(.*shields?\.io.*\)|<img[^>]+shields?\.io/i);
    });

    it("links to docs/roadmap.md", () => {
      expect(readme).toMatch(/docs\/roadmap\.md/);
    });

    it("links to docs/milestones/m6-external-apply.md", () => {
      expect(readme).toMatch(/docs\/milestones\/m6-external-apply\.md/);
    });

    it("links to docs/contracts/intent-apply.md", () => {
      expect(readme).toMatch(/docs\/contracts\/intent-apply\.md/);
    });

    it("links to docs/runners.md", () => {
      expect(readme).toMatch(/docs\/runners\.md/);
    });

    it("links to docs/recovery.md", () => {
      expect(readme).toMatch(/docs\/recovery\.md/);
    });

    it("links to docs/exclusions.md", () => {
      expect(readme).toMatch(/docs\/exclusions\.md/);
    });

    it("links to docs/walkthrough.md", () => {
      expect(readme).toMatch(/docs\/walkthrough\.md/);
    });

    it("links to docs/failure-reset.md", () => {
      expect(readme).toMatch(/docs\/failure-reset\.md/);
    });

    it("links to docs/goal-start.md", () => {
      expect(readme).toMatch(/docs\/goal-start\.md/);
    });

    it("links to docs/daemon.md", () => {
      expect(readme).toMatch(/docs\/daemon\.md/);
    });

    it("links to docs/worker-run.md", () => {
      expect(readme).toMatch(/docs\/worker-run\.md/);
    });

    it("links to docs/doctor.md", () => {
      expect(readme).toMatch(/docs\/doctor\.md/);
    });

    it("links to docs/status.md", () => {
      expect(readme).toMatch(/docs\/status\.md/);
    });

    it("links to docs/handoff.md", () => {
      expect(readme).toMatch(/docs\/handoff\.md/);
    });

    it("links to docs/intent-commands.md", () => {
      expect(readme).toMatch(/docs\/intent-commands\.md/);
    });

    it("links to docs/source-commands.md", () => {
      expect(readme).toMatch(/docs\/source-commands\.md/);
    });

    it("links to docs/evidence-commands.md", () => {
      expect(readme).toMatch(/docs\/evidence-commands\.md/);
    });

    it("links to docs/smoke-tests.md", () => {
      expect(readme).toMatch(/docs\/smoke-tests\.md/);
    });

    it("links to docs/logs.md", () => {
      expect(readme).toMatch(/docs\/logs\.md/);
    });

    it("keeps the top milestone summary compact (no wall-of-text paragraph before CLI Surface)", () => {
      const docStart = readme.indexOf("## Documentation");
      const cliStart = readme.indexOf("## CLI Surface");
      expect(docStart, "## Documentation section should exist").toBeGreaterThanOrEqual(0);
      expect(cliStart, "## CLI Surface section should exist after ## Documentation").toBeGreaterThan(docStart);

      const intro = readme.slice(docStart, cliStart);
      const longestParagraph = intro
        .split(/\n{2,}/)
        .reduce((max, p) => Math.max(max, p.length), 0);
      expect(
        longestParagraph,
        `intro paragraph should be compact (was ${longestParagraph} chars); move milestone history into docs/ or dedicated README sections`
      ).toBeLessThan(1500);
    });

    it("keeps the CLI Surface narrative paragraphs compact (orientation prose, not reference walls)", () => {
      const cliStart = readme.indexOf("## CLI Surface");
      const localDevStart = readme.indexOf("## Local Development");
      expect(cliStart, "## CLI Surface section should exist").toBeGreaterThanOrEqual(0);
      expect(localDevStart, "## Local Development section should exist after ## CLI Surface").toBeGreaterThan(cliStart);

      const cli = readme.slice(cliStart, localDevStart);
      const longestNarrative = cli
        .split(/\n{2,}/)
        .filter((p) => !p.startsWith("```"))
        .reduce((max, p) => Math.max(max, p.length), 0);
      expect(
        longestNarrative,
        `CLI Surface narrative paragraph should be compact (was ${longestNarrative} chars); move per-command reference content into docs/daemon.md / docs/goal-start.md / docs/worker-run.md`
      ).toBeLessThan(800);
    });

    it("keeps the Runner profiles and repo policy sub-section compact (pointer, not bullet wall)", () => {
      const sectionStart = readme.indexOf("### Runner profiles and repo policy");
      expect(sectionStart, "### Runner profiles and repo policy sub-section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "### Runner profiles and repo policy".length);
      const nextHeadingOffset = after.search(/\n## |\n### /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      expect(
        section.length,
        `### Runner profiles and repo policy section should be a compact pointer (was ${section.length} chars); move bullet content into docs/runners.md`
      ).toBeLessThan(500);
    });

    it("keeps the Recovery surfaces sub-section compact (pointer, not bullet wall)", () => {
      const sectionStart = readme.indexOf("### Recovery surfaces (NGX-276, NGX-277)");
      expect(sectionStart, "### Recovery surfaces (NGX-276, NGX-277) sub-section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "### Recovery surfaces (NGX-276, NGX-277)".length);
      const nextHeadingOffset = after.search(/\n## |\n### /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      expect(
        section.length,
        `### Recovery surfaces section should be a compact pointer (was ${section.length} chars); move bullet content into docs/recovery.md`
      ).toBeLessThan(400);
    });

    it("keeps the Milestone 3 Alignment section compact (pointer, not duplicated narrative)", () => {
      const sectionStart = readme.indexOf("## Milestone 3 Alignment");
      expect(sectionStart, "## Milestone 3 Alignment section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "## Milestone 3 Alignment".length);
      const nextHeadingOffset = after.search(/\n## /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      expect(
        section.length,
        `## Milestone 3 Alignment section should be a compact pointer (was ${section.length} chars); move narrative into docs/milestones/m3-operational-safety.md`
      ).toBeLessThan(400);
    });

    it("keeps the Milestone 4 Roadmap section compact (pointer, not duplicated narrative)", () => {
      const sectionStart = readme.indexOf("## Milestone 4 Roadmap");
      expect(sectionStart, "## Milestone 4 Roadmap section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "## Milestone 4 Roadmap".length);
      const nextHeadingOffset = after.search(/\n## /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      expect(
        section.length,
        `## Milestone 4 Roadmap section should be a compact pointer (was ${section.length} chars); move narrative into docs/milestones/m4-real-runners.md`
      ).toBeLessThan(550);
    });

    it("keeps the Milestone 5 Roadmap section compact (pointer, not duplicated narrative)", () => {
      const sectionStart = readme.indexOf("## Milestone 5 Roadmap");
      expect(sectionStart, "## Milestone 5 Roadmap section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "## Milestone 5 Roadmap".length);
      const nextHeadingOffset = after.search(/\n## /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      expect(
        section.length,
        `## Milestone 5 Roadmap section should be a compact pointer (was ${section.length} chars); move narrative into docs/milestones/m5-source-adapters.md`
      ).toBeLessThan(400);
    });

    it("keeps the Goal Spec narrative compact (orientation prose, not reference wall)", () => {
      const goalSpecStart = readme.indexOf("## Goal Spec");
      const commandsStart = readme.indexOf("## Commands");
      expect(goalSpecStart, "## Goal Spec section should exist").toBeGreaterThanOrEqual(0);
      expect(commandsStart, "## Commands section should exist after ## Goal Spec").toBeGreaterThan(goalSpecStart);
      const goalSpec = readme.slice(goalSpecStart, commandsStart);
      const longestNarrative = goalSpec
        .split(/\n{2,}/)
        .filter((p) => !p.startsWith("```"))
        .reduce((max, p) => Math.max(max, p.length), 0);
      expect(
        longestNarrative,
        `Goal Spec narrative paragraph should be compact (was ${longestNarrative} chars); move frontmatter reference into docs/goal-spec.md`
      ).toBeLessThan(700);
    });

    it("links to docs/goal-spec.md", () => {
      expect(readme).toMatch(/docs\/goal-spec\.md/);
    });

    it("keeps the Data Directory section compact (pointer + tree, not duplicated lifecycle prose)", () => {
      const sectionStart = readme.indexOf("## Data Directory");
      expect(sectionStart, "## Data Directory section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "## Data Directory".length);
      const nextHeadingOffset = after.search(/\n## /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      const longestNarrative = section
        .split(/\n{2,}/)
        .filter((p) => !p.startsWith("```"))
        .reduce((max, p) => Math.max(max, p.length), 0);
      expect(
        longestNarrative,
        `Data Directory narrative paragraph should be compact (was ${longestNarrative} chars); move artifact-lifecycle prose into docs/data-directory.md`
      ).toBeLessThan(600);
    });

    it("links to docs/data-directory.md", () => {
      expect(readme).toMatch(/docs\/data-directory\.md/);
    });

    it("keeps the `goal start` sub-section compact (single pointer paragraph, not duplicated taxonomy)", () => {
      const sectionStart = readme.indexOf("### `goal start`");
      expect(sectionStart, "### `goal start` sub-section should exist").toBeGreaterThanOrEqual(0);
      const after = readme.slice(sectionStart + "### `goal start`".length);
      const nextHeadingOffset = after.search(/\n## |\n### /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      expect(
        section.length,
        `### \`goal start\` section should be a compact pointer (was ${section.length} chars); move taxonomy listing into docs/goal-start.md`
      ).toBeLessThan(1200);
      const narrative = section
        .split(/\n{2,}/)
        .filter((p) => p.trim().length > 0 && !p.trim().startsWith("```"));
      expect(
        narrative.length,
        `### \`goal start\` should have one pointer paragraph alongside the CLI shape block (was ${narrative.length} narrative paragraphs)`
      ).toBe(1);
    });

    it("consolidates the daemon start / stop / status commands under a single combined ### heading", () => {
      const combinedHeading = "### `daemon start`, `daemon stop`, `daemon status`";
      const sectionStart = readme.indexOf(combinedHeading);
      expect(
        sectionStart,
        `${combinedHeading} consolidated sub-section should exist (matches the source / intent / evidence consolidation pattern)`
      ).toBeGreaterThanOrEqual(0);
      expect(
        readme.indexOf("### `daemon start`\n"),
        "standalone ### `daemon start` heading should be removed in favour of the combined heading"
      ).toBe(-1);
      expect(
        readme.indexOf("### `daemon stop`\n"),
        "standalone ### `daemon stop` heading should be removed in favour of the combined heading"
      ).toBe(-1);
      expect(
        readme.indexOf("### `daemon status`\n"),
        "standalone ### `daemon status` heading should be removed in favour of the combined heading"
      ).toBe(-1);
      const after = readme.slice(sectionStart + combinedHeading.length);
      const nextHeadingOffset = after.search(/\n## |\n### /);
      const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
      for (const cmd of [
        "momentum daemon start",
        "momentum daemon stop",
        "momentum daemon status"
      ]) {
        expect(
          section,
          `consolidated daemon sub-section should preserve the ${cmd} CLI shape line`
        ).toContain(cmd);
      }
      expect(
        section,
        "consolidated daemon sub-section should point at docs/daemon.md"
      ).toMatch(/docs\/daemon\.md/);
      expect(
        section.length,
        `consolidated daemon sub-section should be a compact pointer (was ${section.length} chars); move register-only / managed-loop / stop-now / inspector detail into docs/daemon.md`
      ).toBeLessThan(1400);
      const narrative = section
        .split(/\n{2,}/)
        .filter((p) => p.trim().length > 0 && !p.trim().startsWith("```"));
      expect(
        narrative.length,
        `consolidated daemon sub-section should have one pointer paragraph alongside the combined CLI shape block (was ${narrative.length} narrative paragraphs)`
      ).toBe(1);
    });

    it("keeps every Commands sub-section a compact single-paragraph pointer with a docs link", () => {
      const cmdStart = readme.indexOf("## Commands");
      const cmdEnd = readme.indexOf("\n## ", cmdStart + 1);
      expect(cmdStart, "## Commands section should exist").toBeGreaterThanOrEqual(0);
      expect(cmdEnd, "a ## section should follow ## Commands").toBeGreaterThan(cmdStart);
      const commands = readme.slice(cmdStart, cmdEnd);
      const headings = [...commands.matchAll(/^### .+$/gm)];
      expect(
        headings.length,
        "## Commands should contain at least one ### sub-section"
      ).toBeGreaterThan(0);
      for (let i = 0; i < headings.length; i++) {
        const heading = headings[i]!;
        const next = headings[i + 1];
        const start = (heading.index ?? 0) + heading[0].length;
        const end = next ? (next.index ?? commands.length) : commands.length;
        const section = commands.slice(start, end);
        const label = heading[0];
        expect(
          section.length,
          `${label} should be a compact pointer (was ${section.length} chars); move reference content into a docs/<command>.md page`
        ).toBeLessThan(1600);
        const narrative = section
          .split(/\n{2,}/)
          .filter((p) => p.trim().length > 0 && !p.trim().startsWith("```"));
        expect(
          narrative.length,
          `${label} should have exactly one pointer paragraph alongside its CLI shape block (was ${narrative.length} narrative paragraphs); collapse duplicated taxonomy or bullet lists into the linked docs page`
        ).toBe(1);
        expect(
          section,
          `${label} should link to its canonical docs/<command>.md reference`
        ).toMatch(/docs\/[\w./-]+\.md/);
      }
    });

    it("keeps the trailing README pointer sections compact (Failure and Reset / Walkthrough / Current Exclusions)", () => {
      const pointers: { heading: string; maxChars: number; docsLink: string }[] = [
        { heading: "## Failure and Reset Semantics", maxChars: 600, docsLink: "docs/failure-reset.md" },
        { heading: "## End-to-end Walkthrough", maxChars: 600, docsLink: "docs/walkthrough.md" },
        { heading: "## Current Exclusions", maxChars: 700, docsLink: "docs/exclusions.md" },
      ];
      for (const { heading, maxChars, docsLink } of pointers) {
        const sectionStart = readme.indexOf(heading);
        expect(sectionStart, `${heading} section should exist`).toBeGreaterThanOrEqual(0);
        const after = readme.slice(sectionStart + heading.length);
        const nextHeadingOffset = after.search(/\n## /);
        const section = nextHeadingOffset >= 0 ? after.slice(0, nextHeadingOffset) : after;
        expect(
          section.length,
          `${heading} should be a compact pointer (was ${section.length} chars); move bullet content into ${docsLink}`
        ).toBeLessThan(maxChars);
        const narrative = section
          .split(/\n{2,}/)
          .filter((p) => p.trim().length > 0 && !p.trim().startsWith("```"));
        expect(
          narrative.length,
          `${heading} should be a single pointer paragraph (was ${narrative.length} narrative paragraphs); collapse duplicated narrative into ${docsLink}`
        ).toBe(1);
        expect(
          section,
          `${heading} should link to its canonical ${docsLink} reference`
        ).toContain(docsLink);
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

    it("points future agents to docs/ for the source of truth", () => {
      expect(agents).toMatch(/docs\/(roadmap|milestones|contracts)/);
    });

    it("stays compact (under 200 lines) after the OSS reshape", () => {
      const lineCount = agents.split("\n").length;
      expect(lineCount, `AGENTS.md should be compact, was ${lineCount} lines`).toBeLessThan(200);
    });

    it("Milestone 3 alignment section points to the canonical M3 docs page", () => {
      const section = agents.slice(agents.indexOf("## Milestone 3 alignment"));
      expect(section).toMatch(/docs\/milestones\/m3-operational-safety\.md/);
    });

    it("Milestone 4 contract section points to the canonical M4 docs page", () => {
      const start = agents.indexOf("## Milestone 4 contract");
      const end = agents.indexOf("## Milestone 3 alignment", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/docs\/milestones\/m4-real-runners\.md/);
    });

    it("Milestone 5 contract section points to the canonical M5 docs page", () => {
      const start = agents.indexOf("## Milestone 5 contract");
      const end = agents.indexOf("## Milestone 4 contract", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/docs\/milestones\/m5-source-adapters\.md/);
    });

    it("Data and artifact layout section points to docs/data-directory.md and stays compact", () => {
      const start = agents.indexOf("## Data and artifact layout");
      expect(start, "AGENTS.md should still declare a ## Data and artifact layout section").toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section).toMatch(/docs\/data-directory\.md/);
      expect(
        section.length,
        `## Data and artifact layout section should be compact (was ${section.length} chars); move per-table / per-file detail into docs/data-directory.md`
      ).toBeLessThan(700);
    });

    it("CLI expectations section points to README/docs and stays compact while preserving the M3 CLI bullets", () => {
      const start = agents.indexOf("## CLI expectations");
      expect(start, "AGENTS.md should still declare a ## CLI expectations section").toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(section, "## CLI expectations should point at README.md for the CLI surface").toMatch(
        /README\.md/
      );
      expect(section, "## CLI expectations should point at docs/ for per-command envelopes").toMatch(
        /docs\//
      );
      for (const cmd of ["`daemon start`", "`daemon stop`", "`daemon status`", "`recovery clear`", "`doctor`"]) {
        expect(section, `## CLI expectations should preserve the M3 CLI bullet ${cmd}`).toContain(cmd);
      }
      expect(
        section.length,
        `## CLI expectations section should be compact (was ${section.length} chars); move per-command surface listings into README.md and docs/<command>.md`
      ).toBeLessThan(800);
    });

    it("Stack and workflow commands section points to README and stays compact", () => {
      const start = agents.indexOf("## Stack and workflow commands");
      expect(
        start,
        "AGENTS.md should still declare a ## Stack and workflow commands section"
      ).toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(
        section,
        "## Stack and workflow commands should point at README.md's ## Local Development block"
      ).toMatch(/README\.md/);
      for (const tech of ["TypeScript", "Node.js", "Vitest", "pnpm"]) {
        expect(
          section,
          `## Stack and workflow commands should still name the ${tech} stack token`
        ).toContain(tech);
      }
      expect(
        section.length,
        `## Stack and workflow commands section should be compact (was ${section.length} chars); move command listings into README.md's ## Local Development block`
      ).toBeLessThan(400);
    });

    it("Current milestone section stays compact (docs/roadmap.md pointer + per-milestone status bullets, not per-NGX changelog)", () => {
      const start = agents.indexOf("## Current milestone");
      expect(
        start,
        "AGENTS.md should still declare a ## Current milestone section"
      ).toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(
        section,
        "## Current milestone should link to docs/roadmap.md as the canonical timeline pointer"
      ).toMatch(/docs\/roadmap\.md/);
      expect(
        section.length,
        `## Current milestone section should be compact (was ${section.length} chars); move per-NGX changelog detail into the linked docs/milestones/*.md pages`
      ).toBeLessThan(1500);
    });

    it("Milestone 6 contract section stays bounded (headline rules + docs/ pointers, not unbounded re-bloat)", () => {
      const start = agents.indexOf("## Milestone 6 contract");
      expect(
        start,
        "AGENTS.md should still declare a ## Milestone 6 contract section"
      ).toBeGreaterThan(-1);
      const end = agents.indexOf("\n## ", start + 1);
      const section = agents.slice(start, end > start ? end : undefined);
      expect(
        section,
        "## Milestone 6 contract should link to docs/milestones/m6-external-apply.md as the canonical M6 scope pointer"
      ).toMatch(/docs\/milestones\/m6-external-apply\.md/);
      expect(
        section,
        "## Milestone 6 contract should link to docs/contracts/intent-apply.md as the canonical two-phase apply contract pointer"
      ).toMatch(/docs\/contracts\/intent-apply\.md/);
      expect(
        section.length,
        `## Milestone 6 contract section should stay bounded (was ${section.length} chars); add new M6 detail to the linked docs/milestones/m6-external-apply.md or docs/contracts/intent-apply.md instead of growing AGENTS.md`
      ).toBeLessThan(2500);
    });

    it("Milestone 3/4/5 contract pointer sections stay compact docs/ pointers", () => {
      const milestonePointerBudgets: Array<{
        heading: string;
        docsLink: RegExp;
        maxChars: number;
      }> = [
        {
          heading: "## Milestone 3 alignment",
          docsLink: /docs\/milestones\/m3-operational-safety\.md/,
          maxChars: 800,
        },
        {
          heading: "## Milestone 4 contract",
          docsLink: /docs\/milestones\/m4-real-runners\.md/,
          maxChars: 1200,
        },
        {
          heading: "## Milestone 5 contract",
          docsLink: /docs\/milestones\/m5-source-adapters\.md/,
          maxChars: 1500,
        },
      ];

      for (const { heading, docsLink, maxChars } of milestonePointerBudgets) {
        const start = agents.indexOf(heading);
        expect(start, `AGENTS.md should still declare a ${heading} section`).toBeGreaterThan(-1);
        const end = agents.indexOf("\n## ", start + 1);
        const section = agents.slice(start, end > start ? end : undefined);
        expect(
          section,
          `${heading} section should link to its canonical docs/ page`
        ).toMatch(docsLink);
        expect(
          section.length,
          `${heading} section should be a compact docs pointer (was ${section.length} chars); move per-milestone narrative into the linked docs/milestones/*.md page`
        ).toBeLessThan(maxChars);
      }
    });

    it("agent operating-instruction sections stay compact (no narrative re-bloat)", () => {
      const operatingSectionBudgets: Array<{
        heading: string;
        maxChars: number;
      }> = [
        { heading: "## Project purpose", maxChars: 500 },
        { heading: "## Coding discipline", maxChars: 500 },
        { heading: "## Local agent run artifacts", maxChars: 500 },
        { heading: "## Verification before completion", maxChars: 500 },
      ];

      for (const { heading, maxChars } of operatingSectionBudgets) {
        const start = agents.indexOf(heading);
        expect(
          start,
          `AGENTS.md should still declare a ${heading} section`
        ).toBeGreaterThan(-1);
        const end = agents.indexOf("\n## ", start + 1);
        const section = agents.slice(start, end > start ? end : undefined);
        expect(
          section.length,
          `${heading} section should stay a compact agent-operating-instruction block (was ${section.length} chars); move detail into docs/ rather than growing AGENTS.md`
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

    it("every docs/*.md file on disk is linked from README.md", () => {
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

      const readme = readDoc("README.md");
      const matches = readme.match(/docs\/[A-Za-z0-9./_-]+\.md/g) ?? [];
      const linked = new Set(matches);

      const orphans = allDocs.filter((doc) => !linked.has(doc));
      expect(
        orphans,
        `README.md should link to every docs/*.md page so each is reachable from the OSS front door (orphans: ${orphans.join(", ")})`
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

  it("doctor is NOT prematurely marked M6 complete", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toMatch(/Milestone 6:.*complete/);
    expect(cli).toContain(
      "Milestone 5: source adapters and evidence sync (NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294) complete"
    );
  });
});
