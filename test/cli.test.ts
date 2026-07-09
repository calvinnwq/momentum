import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DOCTOR_SCOPE, VERSION, runCli } from "../src/cli.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

describe("momentum CLI scaffold", () => {
  it("prints help with the public workflow-first commands", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("momentum workflow status");
    expect(result.stdout).toContain("momentum daemon start");
    expect(result.stdout).toContain("momentum recovery clear <goal-id>");
    expect(result.stdout).toContain("momentum doctor");
    expect(result.stdout).not.toContain("momentum goal start");
    expect(result.stdout).not.toContain("momentum status [goal-id]");
    expect(result.stdout).not.toContain("momentum logs <goal-id>");
    expect(result.stdout).not.toContain("momentum handoff <goal-id>");
    expect(result.stdout).not.toContain("momentum worker run");
    expect(result.stderr).toBe("");
  });

  it("prints the scaffold version", async () => {
    const result = await run(["--version"]);

    expect(result).toEqual({
      code: 0,
      stdout: `${VERSION}\n`,
      stderr: ""
    });
  });

  it("runs doctor in text mode", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-");
    const result = await run(["doctor", "--data-dir", dataDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Momentum doctor: ok");
    expect(result.stdout).toContain(`scope: ${DOCTOR_SCOPE}`);
    expect(result.stdout).toContain("daemon: never started");
    expect(result.stdout).toContain(
      "evidence: total=0 goal_linked=0 source_item_linked=0"
    );
    expect(result.stdout).toContain("evidence: no records ingested yet");
    expect(result.stderr).toBe("");
  });

  it("runs doctor in json mode", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-");
    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "doctor",
      version: VERSION,
      milestone: DOCTOR_SCOPE
    });
    expect(payload["daemon"]).toEqual({
      ok: true,
      dataDir,
      hasRun: false,
      state: null,
      isActive: false,
      stale: false,
      staleRunCount: 0,
      staleRepoLockCount: 0,
      staleClaimedJobCount: 0,
      goalsNeedingRecoveryCount: 0,
      runId: null
    });
    expect(payload["runners"]).toEqual({
      supported: ["fake", "trusted-shell", "acp"],
      default: "fake",
      profiles: [
        {
          kind: "fake",
          name: "fake",
          description:
            "Built-in compatibility fake runner profile retained for stored goal-first data and diagnostics; the retired lane wrote a fixture file and reported a normalized result.",
          executes: true
        },
        {
          kind: "trusted-shell",
          name: "trusted-shell",
          description:
            "Operator-trusted executable-plus-argv compatibility profile retained for stored goal-first data and diagnostics; the retired lane ran the configured command with no implicit shell, no sandbox, and no privilege drop.",
          executes: true
        },
        {
          kind: "acp",
          name: "acp",
          description:
            "ACP/acpx-style compatibility profile retained for stored goal-first data and diagnostics; the retired lane spawned the configured external agent runtime and reported missing runtime/auth as `runtime_unavailable` without corrupting Goal state.",
          executes: true
        }
      ]
    });
    expect(payload["evidence"]).toEqual({
      ok: true,
      totalRecords: 0,
      goalLinkedRecords: 0,
      sourceItemLinkedRecords: 0,
      lastRecord: null
    });
    expect(result.stderr).toBe("");
  });

  it("doctor --json counts goals needing manual recovery from durable state", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-recovery-");
    const { openDb } = await import("../src/adapters/db.js");
    const { markGoalNeedsManualRecovery } = await import(
      "../src/core/goal/recovery.js"
    );

    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "g-doctor-recovery",
        "Doctor CLI recovery goal",
        "momentum/test",
        "/tmp/test",
        1,
        1
      );
      markGoalNeedsManualRecovery(db, {
        goalId: "g-doctor-recovery",
        reason: "repo_dirty",
        now: 2
      });
    } finally {
      db.close();
    }

    const jsonResult = await run([
      "doctor",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    const daemon = payload["daemon"] as Record<string, unknown>;
    expect(daemon["goalsNeedingRecoveryCount"]).toBe(1);

    const textResult = await run([
      "doctor",
      "--data-dir", dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("goals needing manual recovery: 1");
  });

  it("doctor --json surfaces MOMENTUM.md policy when --repo points at a repo with a policy file", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-policy-");
    const repo = makeTempDir("momentum-cli-doctor-repo-");
    fs.writeFileSync(
      path.join(repo, "MOMENTUM.md"),
      `---\nrunner: trusted-shell\nverification:\n  - pnpm test\nverification_timeout_sec: 1200\n---\nPolicy notes body.\n`,
      "utf-8"
    );

    const result = await run([
      "doctor",
      "--repo",
      repo,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const policy = payload["policy"] as Record<string, unknown>;
    expect(policy).toMatchObject({
      repoConfigured: true,
      present: true,
      hasNotes: true,
      error: null
    });
    expect(policy["path"]).toBe(path.join(path.resolve(repo), "MOMENTUM.md"));
    const cfg = policy["config"] as Record<string, unknown>;
    expect(cfg).toEqual({
      runner: "trusted-shell",
      verification: ["pnpm test"],
      verificationTimeoutSec: 1200,
      intentApplyPolicy: null
    });
    expect(policy["effectiveIntentApply"]).toEqual({
      value: "create_intents_only",
      source: "builtin_default"
    });
  });

  it("doctor --json reports repoConfigured:false when --repo is omitted", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-nopol-");
    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const policy = payload["policy"] as Record<string, unknown>;
    expect(policy).toMatchObject({
      repoConfigured: false,
      present: false,
      path: null,
      error: null,
      config: null
    });
  });

  it("doctor --json reports policy_schema_invalid when MOMENTUM.md is malformed", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-bad-policy-");
    const repo = makeTempDir("momentum-cli-doctor-bad-repo-");
    fs.writeFileSync(
      path.join(repo, "MOMENTUM.md"),
      `---\nrunner: 42\n---\n`,
      "utf-8"
    );
    const result = await run([
      "doctor",
      "--repo",
      repo,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const policy = payload["policy"] as Record<string, unknown>;
    expect(policy).toMatchObject({
      repoConfigured: true,
      present: false
    });
    const error = policy["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("policy_schema_invalid");
    expect(typeof error["message"]).toBe("string");
  });

  it("doctor surfaces an ingested-evidence summary with last record details", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-evidence-");
    const { openDb } = await import("../src/adapters/db.js");
    const { ingestEvidenceRecord } = await import(
      "../src/core/evidence/records.js"
    );
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-doctor", "doctor evidence goal", "momentum/test", "/tmp/test", 1, 1);
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title,
            status, metadata_json, last_observed_at, goal_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "si-doctor",
        "linear",
        "ext-doctor",
        "NGX-291",
        "https://linear.app/example/issue/NGX-291",
        "Workflow evidence ingestion",
        "open",
        "{}",
        1,
        null,
        1,
        1
      );

      ingestEvidenceRecord(
        db,
        {
          source: "agent-workflow",
          type: "plan_created",
          formatVersion: 1,
          artifactPath: "/tmp/.agent-workflows/cwfp-doc/plan.json",
          externalId: "cwfp-doc",
          occurredAt: 1_000,
          summary: "Plan created",
          metadata: { mode: "execute-ready" },
          ingestKey: "agent-workflow:cwfp-doc:plan_created"
        },
        { now: () => 1_100 }
      );
      ingestEvidenceRecord(
        db,
        {
          source: "agent-workflow",
          type: "merge_complete",
          formatVersion: 1,
          artifactPath: "/tmp/.agent-workflows/cwfp-doc/ledger.jsonl",
          externalId: "cwfp-doc",
          occurredAt: 9_000,
          summary: "Merge complete",
          metadata: { pr: "https://example/pull/1" },
          ingestKey: "agent-workflow:cwfp-doc:merge_complete",
          goalId: "goal-doctor",
          sourceItemId: "si-doctor"
        },
        { now: () => 9_100 }
      );
    } finally {
      db.close();
    }

    const jsonResult = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    const evidence = payload["evidence"] as Record<string, unknown>;
    expect(evidence).toMatchObject({
      ok: true,
      totalRecords: 2,
      goalLinkedRecords: 1,
      sourceItemLinkedRecords: 1,
      lastRecord: {
        source: "agent-workflow",
        type: "merge_complete",
        occurredAt: 9_000,
        summary: "Merge complete",
        goalId: "goal-doctor",
        sourceItemId: "si-doctor"
      }
    });
    expect(typeof (evidence["lastRecord"] as Record<string, unknown>)["id"]).toBe(
      "string"
    );

    const textResult = await run(["doctor", "--data-dir", dataDir]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain(
      "evidence: total=2 goal_linked=1 source_item_linked=1"
    );
    expect(textResult.stdout).toContain(
      "evidence: last agent-workflow/merge_complete at 9000 (goal=goal-doctor, source_item=si-doctor)"
    );
  });

  it("doctor --json reports an empty externalApply payload when no audits exist", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-externalapply-empty-");
    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["externalApply"]).toEqual({
      ok: true,
      intentApplyStateCounts: { idle: 0, in_flight: 0, blocked: 0 },
      auditCounts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      totalAttempts: 0,
      latestAttempt: null
    });

    const textResult = await run(["doctor", "--data-dir", dataDir]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain(
      "external apply: intents idle=0 in_flight=0 blocked=0"
    );
    expect(textResult.stdout).toContain(
      "external apply: attempts total=0 succeeded=0 failed=0 claimed=0 blocked=0 audit_incomplete=0"
    );
    expect(textResult.stdout).toContain("external apply: no attempts recorded yet");
  });

  it("doctor --json surfaces audit lifecycle counts and the latest attempt across intents", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-externalapply-counts-");
    const { openDb } = await import("../src/adapters/db.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const { claimIntentApply, finalizeIntentApply } = await import(
      "../src/core/intent/apply-audits.js"
    );

    const db = openDb(dataDir);
    let succeededIntentId = "";
    let failedIntentId = "";
    let latestAuditId = "";
    try {
      const failed = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          targetExternalId: "NGX-failed",
          intentType: "source_satisfied",
          reason: "failed attempt",
          idempotencyKey: "linear:NGX-failed:source_satisfied:goal-1"
        },
        { now: () => 1_000 }
      );
      failedIntentId = failed.intent.id;
      const succeeded = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          targetExternalId: "NGX-succeeded",
          intentType: "source_satisfied",
          reason: "succeeded attempt",
          idempotencyKey: "linear:NGX-succeeded:source_satisfied:goal-2"
        },
        { now: () => 1_500 }
      );
      succeededIntentId = succeeded.intent.id;

      const failClaim = claimIntentApply(db, {
        intentId: failedIntentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "NGX-failed",
          externalKey: "NGX-failed",
          url: "https://linear.app/example/issue/NGX-failed",
          title: "Failed issue"
        },
        operatorReason: "verified done",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment on NGX-failed",
        idempotencyMarker: "momentum-intent:linear:NGX-failed:f1",
        now: 2_000
      });
      if (!failClaim.ok) throw new Error("expected failed claim ok");
      const failFinalize = finalizeIntentApply(db, {
        auditId: failClaim.audit.id,
        lifecycleState: "failed",
        resultCode: "write_rejected",
        resultMessage: "Linear rejected",
        now: 2_100
      });
      if (!failFinalize.ok) throw new Error("expected failed finalize ok");

      const succClaim = claimIntentApply(db, {
        intentId: succeededIntentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "NGX-succeeded",
          externalKey: "NGX-succeeded",
          url: "https://linear.app/example/issue/NGX-succeeded",
          title: "Succeeded issue"
        },
        operatorReason: "verified done",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment on NGX-succeeded",
        idempotencyMarker: "momentum-intent:linear:NGX-succeeded:s1",
        now: 3_000
      });
      if (!succClaim.ok) throw new Error("expected succeeded claim ok");
      const succFinalize = finalizeIntentApply(db, {
        auditId: succClaim.audit.id,
        lifecycleState: "succeeded",
        resultCode: "comment_created",
        resultMessage: "linear comment created",
        externalRefs: {
          commentId: "linear_comment_77",
          commentUrl: "https://linear.app/example/comment/77"
        },
        now: 3_100
      });
      if (!succFinalize.ok) throw new Error("expected succeeded finalize ok");
      latestAuditId = succClaim.audit.id;
    } finally {
      db.close();
    }

    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const externalApply = payload["externalApply"] as {
      ok: boolean;
      intentApplyStateCounts: Record<string, number>;
      auditCounts: Record<string, number>;
      totalAttempts: number;
      latestAttempt: {
        id: string;
        intentId: string;
        lifecycleState: string;
        resultStatus: string;
        resultCode: string;
        externalRefs: { commentId: string | null };
        idempotencyMarker: string;
      } | null;
    };
    expect(externalApply.ok).toBe(true);
    expect(externalApply.intentApplyStateCounts).toEqual({
      idle: 2,
      in_flight: 0,
      blocked: 0
    });
    expect(externalApply.auditCounts).toEqual({
      claimed: 0,
      succeeded: 1,
      failed: 1,
      blocked: 0,
      audit_incomplete: 0
    });
    expect(externalApply.totalAttempts).toBe(2);
    expect(externalApply.latestAttempt).not.toBeNull();
    expect(externalApply.latestAttempt?.id).toBe(latestAuditId);
    expect(externalApply.latestAttempt?.intentId).toBe(succeededIntentId);
    expect(externalApply.latestAttempt?.lifecycleState).toBe("succeeded");
    expect(externalApply.latestAttempt?.resultStatus).toBe("succeeded");
    expect(externalApply.latestAttempt?.resultCode).toBe("comment_created");
    expect(externalApply.latestAttempt?.externalRefs.commentId).toBe(
      "linear_comment_77"
    );
    expect(
      externalApply.latestAttempt?.idempotencyMarker.toLowerCase()
    ).not.toContain("token");

    const textResult = await run(["doctor", "--data-dir", dataDir]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain(
      "external apply: intents idle=2 in_flight=0 blocked=0"
    );
    expect(textResult.stdout).toContain(
      "external apply: attempts total=2 succeeded=1 failed=1 claimed=0 blocked=0 audit_incomplete=0"
    );
    expect(textResult.stdout).toContain(
      `external apply: latest ${latestAuditId} intent=${succeededIntentId} succeeded`
    );
  });

  it("doctor --json reflects in_flight and blocked intent counts from the CAS column", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-externalapply-states-");
    const { openDb } = await import("../src/adapters/db.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const { claimIntentApply, finalizeIntentApply } = await import(
      "../src/core/intent/apply-audits.js"
    );

    const db = openDb(dataDir);
    try {
      const blocked = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          targetExternalId: "NGX-blocked",
          intentType: "source_satisfied",
          reason: "audit incomplete",
          idempotencyKey: "linear:NGX-blocked:source_satisfied:goal-1"
        },
        { now: () => 1_000 }
      );
      const inflight = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          targetExternalId: "NGX-inflight",
          intentType: "source_satisfied",
          reason: "still claimed",
          idempotencyKey: "linear:NGX-inflight:source_satisfied:goal-2"
        },
        { now: () => 1_500 }
      );

      const blockedClaim = claimIntentApply(db, {
        intentId: blocked.intent.id,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "NGX-blocked",
          externalKey: "NGX-blocked",
          url: "https://linear.app/example/issue/NGX-blocked",
          title: "Blocked issue"
        },
        operatorReason: "verified done",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment on NGX-blocked",
        idempotencyMarker: "momentum-intent:linear:NGX-blocked:b1",
        now: 2_000
      });
      if (!blockedClaim.ok) throw new Error("expected blocked claim ok");
      const blockedFinalize = finalizeIntentApply(db, {
        auditId: blockedClaim.audit.id,
        lifecycleState: "audit_incomplete",
        resultCode: "audit_finalize_failed",
        now: 2_100
      });
      if (!blockedFinalize.ok) throw new Error("expected blocked finalize ok");

      const inflightClaim = claimIntentApply(db, {
        intentId: inflight.intent.id,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "NGX-inflight",
          externalKey: "NGX-inflight",
          url: "https://linear.app/example/issue/NGX-inflight",
          title: "Inflight issue"
        },
        operatorReason: "verified done",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment on NGX-inflight",
        idempotencyMarker: "momentum-intent:linear:NGX-inflight:i1",
        now: 3_000
      });
      if (!inflightClaim.ok) throw new Error("expected inflight claim ok");
    } finally {
      db.close();
    }

    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const externalApply = payload["externalApply"] as {
      intentApplyStateCounts: Record<string, number>;
      auditCounts: Record<string, number>;
      totalAttempts: number;
      latestAttempt: { lifecycleState: string } | null;
    };
    expect(externalApply.intentApplyStateCounts).toEqual({
      idle: 0,
      in_flight: 1,
      blocked: 1
    });
    expect(externalApply.auditCounts).toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      audit_incomplete: 1
    });
    expect(externalApply.totalAttempts).toBe(2);
    expect(externalApply.latestAttempt?.lifecycleState).toBe("claimed");

    const textResult = await run(["doctor", "--data-dir", dataDir]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain(
      "external apply: intents idle=0 in_flight=1 blocked=1"
    );
    expect(textResult.stdout).toContain(
      "external apply: attempts total=2 succeeded=0 failed=0 claimed=1 blocked=0 audit_incomplete=1"
    );
  });

  it("doctor --json surfaces an active daemon run", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-active-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    const db = openDb(dataDir);
    try {
      // Use a fresh `now` so the default stale window does not classify the
      // record as stale by the time `doctor` is invoked.
      startDaemonRun(db, { pid: 4242, host: "node-doctor", now: Date.now() });
    } finally {
      db.close();
    }

    const result = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const daemon = payload["daemon"] as Record<string, unknown>;
    expect(daemon).toMatchObject({
      ok: true,
      hasRun: true,
      state: "running",
      isActive: true,
      stale: false,
      staleRunCount: 0
    });
    expect(typeof daemon["runId"]).toBe("string");
  });

  it("rejects --data-dir without a value", async () => {
    const result = await run([
      "doctor",
      "--data-dir",
      "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required value for --data-dir."
    });
    expect(result.stdout).toBe("");
  });

  it("rejects unknown commands with usage", async () => {
    const result = await run(["wat"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stderr).toContain("Usage:");
  });

  it("daemon status (no-daemon) exits 0 with hasRun=false in json mode", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon status",
      dataDir,
      hasRun: false,
      daemonRun: null,
      staleRuns: []
    });
    expect(typeof payload["staleAfterMs"]).toBe("number");
    expect(typeof payload["observedAt"]).toBe("number");
    expect(result.stderr).toBe("");
  });

  it("daemon status (no-daemon) text mode prints 'never started'", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daemon: never started");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stderr).toBe("");
  });

  it("daemon status surfaces an active running daemon", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, setDaemonRunActiveJob } = await import(
      "../src/core/daemon/runs.js"
    );
    const db = openDb(dataDir);
    let runId: string;
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 12345,
        host: "node-test",
        now: 1_000
      }));
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: 1_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon status",
      hasRun: true
    });
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0).toMatchObject({
      runId,
      pid: 12345,
      host: "node-test",
      state: "running",
      isActive: true,
      isTerminal: false,
      startedAt: 1_000
    });
    expect(run0["activeJob"]).toEqual({ jobId: "job-1", lockId: "lock-1" });
    expect(run0["stopRequest"]).toBeNull();
    expect(run0["error"]).toBeNull();
    expect(result.stderr).toBe("");
  });

  it("daemon status surfaces stop-requested state with reason", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/core/daemon/runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      requestDaemonRunStop(db, {
        runId,
        reason: "operator-shutdown",
        now: 2_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0).toMatchObject({
      state: "stop_requested",
      isActive: true,
      isTerminal: false
    });
    expect(run0["stopRequest"]).toEqual({
      requestedAt: 2_000,
      reason: "operator-shutdown"
    });
  });

  it("daemon status surfaces terminal error state with last error", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, finishDaemonRun } = await import(
      "../src/core/daemon/runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 1_000 });
      finishDaemonRun(db, {
        runId,
        terminalState: "error",
        error: "kaboom",
        now: 2_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ hasRun: true });
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0).toMatchObject({
      state: "error",
      isActive: false,
      isTerminal: true,
      finishedAt: 2_000
    });
    expect(run0["error"]).toEqual({ message: "kaboom", at: 2_000 });
  });

  it("daemon status flags stale active records without auto-recovering", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    const db = openDb(dataDir);
    try {
      startDaemonRun(db, { pid: 1, now: 100 });
    } finally {
      db.close();
    }

    // Far enough in the future that the default 90s stale cutoff triggers.
    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0["state"]).toBe("running");
    expect(run0["stale"]).toBe(true);
    expect(run0["isActive"]).toBe(true);
    const staleRuns = payload["staleRuns"] as Array<Record<string, unknown>>;
    expect(staleRuns).toHaveLength(1);
    expect(staleRuns[0]).toMatchObject({
      runId: run0["runId"],
      stale: true
    });
  });

  it("daemon status keeps in-flight active work fresh until the active-job cutoff", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, setDaemonRunActiveJob } = await import(
      "../src/core/daemon/runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, {
        pid: 1,
        now: Date.now() - 100_000
      });
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: Date.now() - 100_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const run0 = payload["daemonRun"] as Record<string, unknown>;
    expect(run0["stale"]).toBe(false);
    expect(run0["activeJob"]).toEqual({ jobId: "job-1", lockId: "lock-1" });
    expect(payload["staleRuns"]).toEqual([]);
  });

  it("daemon with no subcommand prints a usage error", async () => {
    const result = await run(["daemon", "--json"]);
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error"
    });
    expect((payload["message"] as string).toLowerCase()).toContain("daemon");
    expect(result.stdout).toBe("");
  });

  it("daemon with unknown subcommand prints a usage error", async () => {
    const result = await run(["daemon", "wat"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown daemon subcommand: wat");
    expect(result.stdout).toBe("");
  });

  it("rejects --now outside daemon stop", async () => {
    const startResult = await run(["daemon", "start", "--now", "--json"]);
    expect(startResult.code).toBe(2);
    expect(startResult.stdout).toBe("");
    const startPayload = JSON.parse(startResult.stderr) as Record<string, unknown>;
    expect(startPayload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "--now is only supported by `momentum daemon stop`."
    });

    const doctorResult = await run(["doctor", "--now"]);
    expect(doctorResult.code).toBe(2);
    expect(doctorResult.stdout).toBe("");
    expect(doctorResult.stderr).toContain(
      "--now is only supported by `momentum daemon stop`."
    );
  });

  it("daemon status rejects extra positional arguments", async () => {
    const result = await run(["daemon", "status", "extra"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for daemon status");
    expect(result.stdout).toBe("");
  });

  it("daemon status surfaces stale repo locks and stale claimed jobs in JSON and text", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-");
    const { openDb } = await import("../src/adapters/db.js");
    const { acquireRepoLock } = await import("../src/core/repo/locks.js");
    const {
      claimPendingGoalIterationJob,
      enqueueGoalIterationJob
    } = await import("../src/core/daemon/queue-jobs.js");
    const db = openDb(dataDir);
    let lockId: string;
    let jobId: string;
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("g1", "test goal", "momentum/test", "/tmp/test", 1, 1);
      const acquired = acquireRepoLock(db, {
        repoRoot: "/tmp/repo",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "preexisting-job",
        leaseExpiresAt: 1_000,
        now: 500
      });
      if (!acquired.ok) throw new Error("seed lock did not acquire");
      lockId = acquired.lockId;

      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 100
      });
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "worker-b",
        leaseDurationMs: 1_000,
        now: 200
      });
      if (!claimed.ok) throw new Error("seed claim failed");
      jobId = claimed.job.id;
    } finally {
      db.close();
    }

    const jsonResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(typeof payload["staleLeaseGraceMs"]).toBe("number");
    const staleLocks = payload["staleRepoLocks"] as Array<Record<string, unknown>>;
    expect(staleLocks).toHaveLength(1);
    expect(staleLocks[0]).toMatchObject({
      lockId,
      repoRoot: "/tmp/repo",
      holder: "worker-a",
      goalId: "g1",
      iteration: 1,
      jobId: "preexisting-job",
      state: "active",
      leaseExpiresAt: 1_000
    });
    const staleJobs = payload["staleClaimedJobs"] as Array<Record<string, unknown>>;
    expect(staleJobs).toHaveLength(1);
    expect(staleJobs[0]).toMatchObject({
      jobId,
      goalId: "g1",
      iteration: 1,
      state: "claimed",
      attemptCount: 1,
      workerId: "worker-b",
      leaseAcquiredAt: 200,
      leaseExpiresAt: 1_200
    });

    const textResult = await run([
      "daemon", "status",
      "--data-dir", dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Stale repo locks: 1");
    expect(textResult.stdout).toContain("Stale claimed jobs: 1");
  });

  it("daemon status surfaces goals needing manual recovery in JSON and text", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-recovery-");
    const { openDb } = await import("../src/adapters/db.js");
    const { writeRecoveryArtifact } = await import("../src/core/goal/recovery-artifact.js");
    const { markGoalNeedsManualRecovery } = await import(
      "../src/core/goal/recovery.js"
    );
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("g-needs", "Stuck goal", "momentum/test", "/tmp/test", 1, 1);
      markGoalNeedsManualRecovery(db, {
        goalId: "g-needs",
        reason: "repo_dirty",
        now: 1
      });
      writeRecoveryArtifact({
        dataDir,
        input: {
          goalId: "g-needs",
          goalTitle: "Stuck goal",
          iteration: 1,
          jobId: null,
          daemonRunId: null,
          repoPath: "/tmp/repo",
          expectedCommit: null,
          currentCommit: null,
          reason: { code: "repo_dirty", message: "uncommitted changes" },
          artifactPaths: {
            iterationDir: "/tmp/test/iterations/1",
            promptPath: "/tmp/test/iterations/1/prompt.md",
            runnerLog: null,
            verificationLog: null,
            resultJson: null
          },
          safeNextSteps: ["Inspect the repo working tree"],
          classifiedAt: 1_700_000_000_000
        }
      });
    } finally {
      db.close();
    }

    const jsonResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    const entries = payload["goalsNeedingRecovery"] as Array<
      Record<string, unknown>
    >;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      goalId: "g-needs",
      title: "Stuck goal",
      goalState: "initialized",
      recoveryMdExists: true
    });
    expect(entries[0]?.["recoveryMdPath"]).toMatch(
      /g-needs\/recovery\.md$/
    );

    const textResult = await run([
      "daemon", "status",
      "--data-dir", dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Goals needing manual recovery: 1");
    expect(textResult.stdout).toContain("g-needs");
  });

  it("doctor --json surfaces stale repo-lock and claimed-job counts", async () => {
    const dataDir = makeTempDir("momentum-cli-doctor-stale-");
    const { openDb } = await import("../src/adapters/db.js");
    const { acquireRepoLock } = await import("../src/core/repo/locks.js");
    const {
      claimPendingGoalIterationJob,
      enqueueGoalIterationJob
    } = await import("../src/core/daemon/queue-jobs.js");
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("g1", "test goal", "momentum/test", "/tmp/test", 1, 1);
      const acquired = acquireRepoLock(db, {
        repoRoot: "/tmp/repo",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "preexisting-job",
        leaseExpiresAt: 1_000,
        now: 500
      });
      if (!acquired.ok) throw new Error("seed lock did not acquire");
      enqueueGoalIterationJob(db, {
        goalId: "g1",
        iteration: 1,
        idempotencyKey: "g1:1",
        artifactPath: "/tmp/test/iterations/1",
        now: 100
      });
      const claimed = claimPendingGoalIterationJob(db, {
        workerId: "worker-b",
        leaseDurationMs: 1_000,
        now: 200
      });
      if (!claimed.ok) throw new Error("seed claim failed");
    } finally {
      db.close();
    }

    const result = await run([
      "doctor",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const daemon = payload["daemon"] as Record<string, unknown>;
    expect(daemon).toMatchObject({
      ok: true,
      hasRun: false,
      staleRunCount: 0,
      staleRepoLockCount: 1,
      staleClaimedJobCount: 1
    });
  });

  it("daemon start records a new orchestrator run and exits 0 (json)", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const before = Date.now();
    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);
    const after = Date.now();

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon start",
      dataDir,
      state: "running"
    });
    expect(typeof payload["runId"]).toBe("string");
    expect((payload["runId"] as string).length).toBeGreaterThan(0);
    expect(payload["pid"]).toBe(process.pid);
    expect(typeof payload["host"]).toBe("string");
    expect((payload["host"] as string).length).toBeGreaterThan(0);
    expect(payload["startedAt"]).toBeGreaterThanOrEqual(before);
    expect(payload["startedAt"]).toBeLessThanOrEqual(after);
    expect(payload["heartbeatAt"]).toBe(payload["startedAt"]);
    expect(result.stderr).toBe("");

    // The new record should also be visible via `daemon status`.
    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const daemonRun = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(daemonRun["runId"]).toBe(payload["runId"]);
    expect(daemonRun["state"]).toBe("running");
    expect(daemonRun["isActive"]).toBe(true);
  });

  it("daemon start text mode prints the recorded run summary", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daemon run started:");
    expect(result.stdout).toContain("State: running");
    expect(result.stdout).toContain(`Pid: ${process.pid}`);
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stderr).toBe("");
  });

  it("daemon start refuses to record a second run while one is active", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    let existingRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: existingRunId } = startDaemonRun(db, {
        pid: 77,
        host: "node-existing",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon start",
      code: "daemon_already_active"
    });
    expect(payload["message"]).toContain(existingRunId);
    const existing = payload["existing"] as Record<string, unknown>;
    expect(existing).toMatchObject({
      runId: existingRunId,
      state: "running",
      pid: 77,
      host: "node-existing",
      stale: false
    });
  });

  it("daemon start refuses and flags stale heartbeats on the existing active run", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    let existingRunId: string;
    const db = openDb(dataDir);
    try {
      // Heartbeat far in the past so the default 90s stale cutoff triggers.
      ({ runId: existingRunId } = startDaemonRun(db, { pid: 99, now: 100 }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "daemon_already_active"
    });
    expect(payload["message"]).toContain("stale heartbeat");
    const existing = payload["existing"] as Record<string, unknown>;
    expect(existing).toMatchObject({
      runId: existingRunId,
      stale: true
    });
    expect(existing["heartbeatAgeMs"]).toBeGreaterThanOrEqual(90_000);
  });

  it("daemon start allows a new run once the previous one terminates", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-start-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, finishDaemonRun } = await import(
      "../src/core/daemon/runs.js"
    );
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: Date.now() });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: Date.now() });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon start",
      state: "running"
    });
  });

  it("daemon start rejects extra positional arguments", async () => {
    const result = await run(["daemon", "start", "extra"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for daemon start");
    expect(result.stdout).toBe("");
  });

  it("daemon stop records a stop request on the active run (json)", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    let activeRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: activeRunId } = startDaemonRun(db, {
        pid: 4242,
        host: "node-stop",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const before = Date.now();
    const result = await run([
      "daemon", "stop",
      "--reason", "operator-shutdown",
      "--data-dir", dataDir,
      "--json"
    ]);
    const after = Date.now();

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon stop",
      dataDir,
      runId: activeRunId,
      previousState: "running",
      state: "stop_requested",
      stopReason: "operator-shutdown",
      alreadyStopRequested: false,
      pid: 4242,
      host: "node-stop",
      stale: false
    });
    expect(payload["stopRequestedAt"]).toBeGreaterThanOrEqual(before);
    expect(payload["stopRequestedAt"]).toBeLessThanOrEqual(after);
    expect(typeof payload["heartbeatAgeMs"]).toBe("number");
    expect(result.stderr).toBe("");

    // Status round-trip should reflect the recorded stop request.
    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const daemonRun = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(daemonRun["runId"]).toBe(activeRunId);
    expect(daemonRun["state"]).toBe("stop_requested");
    expect(daemonRun["stopRequest"]).toEqual({
      requestedAt: payload["stopRequestedAt"],
      reason: "operator-shutdown"
    });
  });

  it("daemon stop defaults --reason to 'operator-requested' and prints a text summary", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    const db = openDb(dataDir);
    try {
      startDaemonRun(db, { pid: 11, host: "node-default", now: Date.now() });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Daemon stop requested:");
    expect(result.stdout).toContain("State: stop_requested");
    expect(result.stdout).toContain("Previous state: running");
    expect(result.stdout).toContain("Reason: operator-requested");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stderr).toBe("");
  });

  it("daemon stop is idempotent and refreshes the reason on a stop_requested run", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/core/daemon/runs.js"
    );
    let runId: string;
    const firstRequestedAt = Date.now() - 5_000;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, { pid: 22, now: firstRequestedAt }));
      requestDaemonRunStop(db, {
        runId,
        reason: "initial",
        now: firstRequestedAt
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--reason", "second-call",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon stop",
      runId,
      previousState: "stop_requested",
      state: "stop_requested",
      alreadyStopRequested: true,
      stopReason: "second-call"
    });
    // The original stop_requested_at is preserved (COALESCE in the primitive).
    expect(payload["stopRequestedAt"]).toBe(firstRequestedAt);
    expect(result.stdout).not.toContain("Daemon stop requested:");
  });

  it("daemon stop refuses when no daemon has ever started", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon stop",
      code: "no_active_daemon",
      latest: null
    });
    expect((payload["message"] as string).toLowerCase()).toContain(
      "no active daemon"
    );
  });

  it("daemon stop refuses when the latest run is already terminal and surfaces it", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, finishDaemonRun } = await import(
      "../src/core/daemon/runs.js"
    );
    let runId: string;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 33,
        host: "node-old",
        now: Date.now() - 1_000
      }));
      finishDaemonRun(db, {
        runId,
        terminalState: "stopped",
        now: Date.now()
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon stop",
      code: "no_active_daemon"
    });
    const latest = payload["latest"] as Record<string, unknown>;
    expect(latest).toMatchObject({
      runId,
      state: "stopped",
      pid: 33,
      host: "node-old"
    });
    expect((payload["message"] as string).toLowerCase()).toContain("stopped");
  });

  it("daemon stop flags stale heartbeats on the active run but still records the request", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    let runId: string;
    const db = openDb(dataDir);
    try {
      // Started long ago so heartbeat_at is well past the default 90s cutoff.
      ({ runId } = startDaemonRun(db, { pid: 44, now: 100 }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runId,
      state: "stop_requested",
      stale: true
    });
    expect(payload["heartbeatAgeMs"]).toBeGreaterThanOrEqual(90_000);
  });

  it("daemon stop uses active-job freshness when reporting staleness", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, setDaemonRunActiveJob } = await import(
      "../src/core/daemon/runs.js"
    );
    let runId: string;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 45,
        now: Date.now() - 100_000
      }));
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: Date.now() - 100_000
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runId,
      state: "stop_requested",
      stale: false
    });
    expect(payload["heartbeatAgeMs"]).toBeGreaterThanOrEqual(90_000);
  });

  it("daemon stop rejects extra positional arguments", async () => {
    const result = await run(["daemon", "stop", "extra"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for daemon stop");
    expect(result.stdout).toBe("");
  });

  it("daemon stop rejects --reason without a value", async () => {
    const result = await run(["daemon", "stop", "--reason"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Missing required value for --reason");
    expect(result.stdout).toBe("");
  });

  it("daemon stop --now records an immediate stop request and surfaces stopNowRequestedAt", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    let activeRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: activeRunId } = startDaemonRun(db, {
        pid: 7171,
        host: "node-stop-now",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const before = Date.now();
    const result = await run([
      "daemon", "stop",
      "--now",
      "--data-dir", dataDir,
      "--json"
    ]);
    const after = Date.now();

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon stop",
      runId: activeRunId,
      previousState: "running",
      state: "stop_requested",
      immediate: true,
      alreadyStopNow: false,
      alreadyStopRequested: false,
      stopReason: "operator-requested-immediate"
    });
    expect(payload["stopNowRequestedAt"]).toBeGreaterThanOrEqual(before);
    expect(payload["stopNowRequestedAt"]).toBeLessThanOrEqual(after);

    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const daemonRun = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(daemonRun["stopNowRequest"]).toEqual({
      requestedAt: payload["stopNowRequestedAt"],
      reason: "operator-requested-immediate"
    });
    expect(daemonRun["stopRequest"]).toEqual({
      requestedAt: payload["stopNowRequestedAt"],
      reason: "operator-requested-immediate"
    });
  });

  it("daemon stop --now is idempotent and preserves the first stop-now reason", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, requestDaemonRunImmediateStop } = await import(
      "../src/core/daemon/runs.js"
    );
    let runId: string;
    const firstNowAt = Date.now() - 5_000;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 8181,
        now: firstNowAt - 100
      }));
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "first-now",
        now: firstNowAt
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--now",
      "--reason", "second-now",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runId,
      previousState: "stop_requested",
      state: "stop_requested",
      immediate: true,
      alreadyStopNow: true,
      alreadyStopRequested: true,
      stopReason: "first-now"
    });
    expect(payload["stopNowRequestedAt"]).toBe(firstNowAt);
  });

  it("daemon stop --now text output reports the preserved reason on a repeat call", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, requestDaemonRunImmediateStop } = await import(
      "../src/core/daemon/runs.js"
    );
    let runId: string;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, { pid: 4242, now: Date.now() - 1_000 }));
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "first",
        now: Date.now() - 500
      });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--now",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Daemon stop-now request refreshed: ${runId}`);
    expect(result.stdout).toContain("Stop-now requested at:");
  });

  it("daemon stop --now upgrades a graceful stop_requested run to stop_now", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/core/daemon/runs.js"
    );
    let runId: string;
    const gracefulAt = Date.now() - 3_000;
    const db = openDb(dataDir);
    try {
      ({ runId } = startDaemonRun(db, { pid: 9191, now: gracefulAt - 100 }));
      requestDaemonRunStop(db, { runId, reason: "graceful", now: gracefulAt });
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "stop",
      "--now",
      "--reason", "upgrade",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      runId,
      previousState: "stop_requested",
      state: "stop_requested",
      immediate: true,
      alreadyStopRequested: true,
      alreadyStopNow: false,
      stopReason: "upgrade"
    });
    expect(payload["stopRequestedAt"]).toBe(gracefulAt);
    expect(typeof payload["stopNowRequestedAt"]).toBe("number");
    expect(payload["stopNowRequestedAt"]).toBeGreaterThan(gracefulAt);
  });

  it("daemon stop --now refuses when there is no active daemon", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-stop-");
    const result = await run([
      "daemon", "stop",
      "--now",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon stop",
      code: "no_active_daemon"
    });
  });

  it("daemon start with --max-idle-cycles 0 registers a run and exits with terminalState=stopped", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      workSucceeded: true,
      command: "daemon start",
      dataDir,
      state: "stopped"
    });
    expect(typeof payload["runId"]).toBe("string");
    const loop = payload["loop"] as Record<string, unknown>;
    expect(loop).toMatchObject({
      exitReason: "max_idle_cycles",
      terminalState: "stopped",
      cancelOutcome: null,
      workSucceeded: true,
      iterations: 0,
      jobsRun: 0,
      jobsFailed: 0,
      jobsNotExecuted: 0,
      idleCycles: 0
    });

    // The recorded run should be terminal in status afterwards.
    const statusResult = await run([
      "daemon", "status",
      "--data-dir", dataDir,
      "--json"
    ]);
    const statusPayload = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const run0 = statusPayload["daemonRun"] as Record<string, unknown>;
    expect(run0["state"]).toBe("stopped");
    expect(run0["isActive"]).toBe(false);
  });

  it("daemon start bounded loop keeps the frozen envelope keys and idle drain values", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-envelope-");
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "1",
      "--poll-interval-ms", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "command",
      "dataDir",
      "host",
      "loop",
      "ok",
      "pid",
      "runId",
      "startedAt",
      "state",
      "workSucceeded",
      "workerId"
    ]);

    const loop = payload["loop"] as Record<string, unknown>;
    expect(Object.keys(loop).sort()).toEqual([
      "cancelOutcome",
      "exitReason",
      "idleCycles",
      "iterations",
      "jobsFailed",
      "jobsNotExecuted",
      "jobsRun",
      "lastObservedState",
      "lastWorkerCode",
      "lastWorkflowCode",
      "startupRecovery",
      "terminalState",
      "workSucceeded",
      "workflowStepsDispatched"
    ]);
    // The retired goal-iteration drain lane must keep reporting its idle
    // envelope values so operators and wrappers see an unchanged wire shape.
    expect(loop).toMatchObject({
      exitReason: "max_idle_cycles",
      terminalState: "stopped",
      cancelOutcome: null,
      workSucceeded: true,
      iterations: 1,
      jobsRun: 0,
      jobsFailed: 0,
      jobsNotExecuted: 0,
      idleCycles: 1,
      workflowStepsDispatched: 0,
      lastWorkflowCode: "idle",
      lastObservedState: "running",
      lastWorkerCode: "no_work"
    });
    const startupRecovery = loop["startupRecovery"] as Record<string, unknown>;
    expect(Object.keys(startupRecovery).sort()).toEqual([
      "graceMs",
      "observedAt",
      "recoveredClaimedJobCount",
      "recoveredDaemonRunCount",
      "recoveredRepoLockCount",
      "skippedClaimedJobs",
      "skippedDaemonRuns",
      "skippedRepoLocks"
    ]);

    const textResult = await run([
      "daemon", "start",
      "--max-idle-cycles", "1",
      "--poll-interval-ms", "0",
      "--data-dir", makeTempDir("momentum-cli-daemon-loop-envelope-text-")
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain("Jobs run: 0");
    expect(textResult.stdout).toContain("Jobs failed: 0");
    expect(textResult.stdout).toContain("Jobs not executed: 0");
    expect(textResult.stdout).toContain("Idle cycles: 1");
    expect(textResult.stdout).toContain("Workflow steps dispatched: 0");
  });

  it("daemon start rejects --poll-interval-ms without a loop bound", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const result = await run([
      "daemon", "start",
      "--poll-interval-ms", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--poll-interval-ms requires --max-loop-iterations or --max-idle-cycles."
    );
  });

  it("managed daemon start recovers a stale idle active run before registering", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { getDaemonRun, startDaemonRun } = await import(
      "../src/core/daemon/runs.js"
    );
    let staleRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: staleRunId } = startDaemonRun(db, {
        pid: 5151,
        host: "stale-existing-loop",
        now: 100
      }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "daemon start",
      state: "stopped"
    });
    expect(payload["runId"]).not.toBe(staleRunId);

    const verifyDb = openDb(dataDir);
    try {
      const staleRun = getDaemonRun(verifyDb, staleRunId);
      expect(staleRun).not.toBeNull();
      expect(staleRun?.state).toBe("error");
      expect(staleRun?.recovery_status).toBe("auto_recovered_idle_stale");
    } finally {
      verifyDb.close();
    }
  });

  it("daemon start refuses to run the loop while another daemon is active", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const { openDb } = await import("../src/adapters/db.js");
    const { startDaemonRun } = await import("../src/core/daemon/runs.js");
    let existingRunId: string;
    const db = openDb(dataDir);
    try {
      ({ runId: existingRunId } = startDaemonRun(db, {
        pid: 4242,
        host: "node-existing-loop",
        now: Date.now()
      }));
    } finally {
      db.close();
    }

    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "1",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "daemon start",
      code: "daemon_already_active"
    });
    expect(payload["message"]).toContain(existingRunId);
  });

  it("daemon start text mode prints a loop summary when bounded", async () => {
    const dataDir = makeTempDir("momentum-cli-daemon-loop-");
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles", "0",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Daemon run started:");
    expect(result.stdout).toContain("State: stopped");
    expect(result.stdout).toContain("Exit reason: max_idle_cycles");
    expect(result.stdout).toContain("Work succeeded: yes");
    expect(result.stdout).toContain("Jobs run: 0");
  });

  it("daemon start rejects --max-loop-iterations with a non-integer value", async () => {
    const result = await run([
      "daemon", "start",
      "--max-loop-iterations", "abc"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Invalid value for --max-loop-iterations: abc"
    );
    expect(result.stdout).toBe("");
  });

  it("daemon start rejects --max-idle-cycles without a value", async () => {
    const result = await run([
      "daemon", "start",
      "--max-idle-cycles"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Missing required value for --max-idle-cycles");
    expect(result.stdout).toBe("");
  });

});

describe("momentum recovery clear", () => {
  it("requires a goal-id argument", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const result = await run([
      "recovery", "clear",
      "--data-dir", dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Missing required <goal-id> for recovery clear."
    );
  });

  it("rejects unexpected positional arguments", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const result = await run([
      "recovery", "clear", "g1", "extra",
      "--data-dir", dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for recovery clear: extra"
    );
  });

  it("rejects unknown recovery subcommand", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const result = await run([
      "recovery", "nope",
      "--data-dir", dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown recovery subcommand: nope");
  });

  it("rejects missing recovery subcommand", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const result = await run([
      "recovery",
      "--data-dir", dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Missing required subcommand for recovery. Expected: clear."
    );
  });

  it("returns goal_not_found JSON code when goal does not exist", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const { openDb } = await import("../src/adapters/db.js");
    // Touch db so the file exists with migrations applied.
    openDb(dataDir).close();

    const result = await run([
      "recovery", "clear", "missing-goal",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "recovery clear",
      code: "goal_not_found",
      goalId: "missing-goal"
    });
  });

  it("returns not_flagged when the goal exists but is not currently flagged", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const { openDb } = await import("../src/adapters/db.js");
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("g-clean", "clean goal", "momentum/test", "/tmp/test", 1, 1);
    } finally {
      db.close();
    }

    const result = await run([
      "recovery", "clear", "g-clean",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "recovery clear",
      code: "not_flagged",
      goalId: "g-clean"
    });
  });

  it("returns job_active with activeJobIds when a claimed iteration job still holds the goal", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const { openDb } = await import("../src/adapters/db.js");
    const { enqueueGoalIterationJob } = await import("../src/core/daemon/queue-jobs.js");
    const { markGoalNeedsManualRecovery } = await import(
      "../src/core/goal/recovery.js"
    );

    const db = openDb(dataDir);
    let jobId: string;
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("g-stuck", "stuck goal", "momentum/test", "/tmp/test", 1, 1);
      const enq = enqueueGoalIterationJob(db, {
        goalId: "g-stuck",
        iteration: 1,
        idempotencyKey: "g-stuck:1",
        artifactPath: "/tmp/test/g-stuck/iterations/1",
        now: 1
      });
      jobId = enq.jobId;
      db.prepare(
        `UPDATE jobs SET state = 'claimed', worker_id = 'worker-x' WHERE id = ?`
      ).run(jobId);
      markGoalNeedsManualRecovery(db, {
        goalId: "g-stuck",
        reason: "repo_dirty",
        now: 2
      });
    } finally {
      db.close();
    }

    const result = await run([
      "recovery", "clear", "g-stuck",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "recovery clear",
      code: "job_active",
      goalId: "g-stuck"
    });
    expect(payload["activeJobIds"]).toEqual([jobId]);
  });

  it("clears a flagged goal and surfaces the event id in JSON+text output", async () => {
    const dataDir = makeTempDir("momentum-cli-recovery-");
    const { openDb } = await import("../src/adapters/db.js");
    const { markGoalNeedsManualRecovery } = await import(
      "../src/core/goal/recovery.js"
    );

    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "g-flagged",
        "flagged goal",
        "momentum/test",
        "/tmp/test",
        1,
        1
      );
      markGoalNeedsManualRecovery(db, {
        goalId: "g-flagged",
        reason: "repo_dirty",
        now: 1_700_000_000_000
      });
    } finally {
      db.close();
    }

    const jsonResult = await run([
      "recovery", "clear", "g-flagged",
      "--reason", "operator inspected",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "recovery clear",
      goalId: "g-flagged",
      previousReason: "repo_dirty",
      previousMarkedAt: 1_700_000_000_000
    });
    expect(typeof payload["clearedAt"]).toBe("number");
    expect(typeof payload["eventId"]).toBe("number");

    // Reflagging is required to repeat the clear; second clear should now
    // refuse with not_flagged.
    const secondResult = await run([
      "recovery", "clear", "g-flagged",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(secondResult.code).toBe(1);
    const secondPayload = JSON.parse(secondResult.stderr) as Record<
      string,
      unknown
    >;
    expect(secondPayload).toMatchObject({
      code: "not_flagged"
    });

    // Now re-flag and check the text path surfaces the audit-friendly fields.
    const reflagDb = openDb(dataDir);
    try {
      markGoalNeedsManualRecovery(reflagDb, {
        goalId: "g-flagged",
        reason: "job_running",
        now: 1_700_000_500_000
      });
    } finally {
      reflagDb.close();
    }

    const textResult = await run([
      "recovery", "clear", "g-flagged",
      "--data-dir", dataDir
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain(
      "Manual recovery cleared for goal: g-flagged"
    );
    expect(textResult.stdout).toContain("Previous reason: job_running");
  });

  it("lists and gets source items for operator inspection", async () => {
    const dataDir = makeTempDir("momentum-cli-source-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      upsertSourceItem(
        db,
        {
          adapterKind: "local-fixture",
          externalId: "fixture-1",
          externalKey: "SRC-1",
          url: "https://example.test/source/SRC-1",
          title: "Fixture source item",
          status: "In Progress",
          metadata: { opaque: { priority: "high" } },
          observedAt: 1_700_000_000_000
        },
        { now: () => 1_700_000_000_100 }
      );
      upsertSourceItem(
        db,
        {
          adapterKind: "manual",
          externalId: "manual-1",
          externalKey: "MAN-1",
          title: "Manual source item",
          status: "Todo",
          metadata: { note: "kept opaque" },
          observedAt: 1_700_000_000_200
        },
        { now: () => 1_700_000_000_300 }
      );
    } finally {
      db.close();
    }

    const listResult = await run([
      "source",
      "list",
      "--adapter",
      "local-fixture",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(listResult.code).toBe(0);
    expect(listResult.stderr).toBe("");
    const listPayload = JSON.parse(listResult.stdout) as Record<string, unknown>;
    expect(listPayload).toMatchObject({
      ok: true,
      command: "source list",
      adapter: "local-fixture",
      count: 1
    });
    const items = listPayload["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const firstItem = items[0];
    expect(firstItem).toBeDefined();
    // The exhaustive per-field source-item JSON shape (adapterKind, externalKey,
    // title, status, url, timestamps, ...) is pinned in the fast lane by
    // test/cli-renderers-output-contract.test.ts via a sourceItemToJsonShape
    // toEqual over the full field set. Thinned here (NGX-432) to the end-to-end
    // CLI wiring proof that the renderer unit test cannot cover: the `--adapter`
    // filter selected the right item, an unlinked item serializes goalId as
    // null, and opaque metadata round-trips DB -> command -> renderer -> stdout.
    expect(firstItem).toMatchObject({
      externalId: "fixture-1",
      goalId: null,
      metadata: { opaque: { priority: "high" } }
    });

    const sourceId = firstItem!["id"] as string;
    const getResult = await run([
      "source",
      "get",
      sourceId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(getResult.code).toBe(0);
    const getPayload = JSON.parse(getResult.stdout) as Record<string, unknown>;
    // `source get` envelope + get-by-id wiring and opaque metadata round-trip;
    // the full item field shape is pinned by the fast renderer contract cited
    // above.
    expect(getPayload).toMatchObject({
      ok: true,
      command: "source get",
      item: {
        id: sourceId,
        metadata: { opaque: { priority: "high" } }
      }
    });
  });

  it("source get reports a stable not_found error for unknown source item ids", async () => {
    const dataDir = makeTempDir("momentum-cli-source-missing-");
    const result = await run([
      "source",
      "get",
      "source_item_missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "source get",
      code: "source_item_not_found",
      sourceItemId: "source_item_missing"
    });
  });

  it("source link is idempotent and surfaces previous/current goal ids", async () => {
    const dataDir = makeTempDir("momentum-cli-source-link-");
    const goalId = "goal-link-target";

    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    let sourceItemId: string;
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(goalId, "Link target goal", "momentum/link-target", "/tmp/link-target", 1, 1);
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "local-fixture",
          externalId: "fixture-link-1",
          externalKey: "SRC-LINK-1",
          title: "Linkable source item",
          status: "Todo",
          observedAt: 1_700_000_000_000
        },
        { now: () => 1_700_000_000_100 }
      );
      sourceItemId = item.id;
    } finally {
      db.close();
    }

    const firstLink = await run([
      "source", "link", sourceItemId,
      "--goal", goalId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(firstLink.code).toBe(0);
    const firstPayload = JSON.parse(firstLink.stdout) as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      ok: true,
      command: "source link",
      goalId,
      sourceItemId,
      changed: true,
      previousGoalId: null,
      skippedReason: null
    });

    const secondLink = await run([
      "source", "link", sourceItemId,
      "--goal", goalId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(secondLink.code).toBe(0);
    const secondPayload = JSON.parse(secondLink.stdout) as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      ok: true,
      command: "source link",
      goalId,
      sourceItemId,
      changed: false,
      skippedReason: "already_linked_to_target",
      previousGoalId: goalId
    });
  });

  it("source link creates a pending source_satisfied intent when completed goal evidence already exists", async () => {
    const dataDir = makeTempDir("momentum-cli-source-link-intent-");
    const goalId = "goal-link-intent";

    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const { ingestEvidenceRecord } = await import("../src/core/evidence/records.js");
    const { listUpdateIntents } = await import("../src/core/intent/update-intents.js");
    const db = openDb(dataDir);
    let sourceItemId: string;
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        goalId,
        "Link intent goal",
        "momentum/link-intent",
        "/tmp/link-intent",
        "completed",
        1,
        1
      );
      ingestEvidenceRecord(db, {
        source: "agent-workflow",
        type: "verification_passed",
        occurredAt: 1_700_000_000_200,
        summary: "verification passed",
        goalId,
        ingestKey: `source-link-intent:${goalId}`
      });
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "local-fixture",
          externalId: "fixture-link-intent",
          externalKey: "SRC-LINK-INTENT",
          title: "Intent linkable source item",
          status: "Todo",
          observedAt: 1_700_000_000_000
        },
        { now: () => 1_700_000_000_100 }
      );
      sourceItemId = item.id;
    } finally {
      db.close();
    }

    const link = await run([
      "source", "link", sourceItemId,
      "--goal", goalId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(link.code).toBe(0);
    const payload = JSON.parse(link.stdout) as Record<string, unknown>;
    expect(payload["counts"]).toMatchObject({
      intentsCreated: 1,
      intentsReplayed: 0,
      intentWarnings: 0
    });

    const verifyDb = openDb(dataDir);
    try {
      const intents = listUpdateIntents(verifyDb, {
        status: "pending",
        goalId
      });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.sourceItemId).toBe(sourceItemId);
    } finally {
      verifyDb.close();
    }
  });

  it("source link returns goal_not_found, source_item_not_found, and linked_to_other_goal errors", async () => {
    const dataDir = makeTempDir("momentum-cli-source-link-errors-");
    const goalAId = "goal-a-link-target";

    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    const goalBId = "goal-b-link-target";
    let sourceItemId: string;
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(goalAId, "Goal A", "momentum/goal-a", "/tmp/goal-a", 1, 1);
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(goalBId, "Goal B", "momentum/goal-b", "/tmp/goal-b", 1, 1);
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "local-fixture",
          externalId: "fixture-link-errors-1",
          externalKey: "SRC-LINK-ERR-1",
          title: "Link errors source item",
          status: "Todo",
          observedAt: 1_700_000_000_000
        },
        { now: () => 1_700_000_000_100 }
      );
      sourceItemId = item.id;
    } finally {
      db.close();
    }

    const missingGoal = await run([
      "source", "link", sourceItemId,
      "--goal", "goal-missing",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(missingGoal.code).toBe(1);
    const missingGoalPayload = JSON.parse(missingGoal.stderr) as Record<string, unknown>;
    expect(missingGoalPayload).toMatchObject({
      ok: false,
      command: "source link",
      code: "goal_not_found",
      goalId: "goal-missing",
      sourceItemId
    });

    const missingItem = await run([
      "source", "link", "source_item_missing",
      "--goal", goalAId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(missingItem.code).toBe(1);
    const missingItemPayload = JSON.parse(missingItem.stderr) as Record<string, unknown>;
    expect(missingItemPayload).toMatchObject({
      ok: false,
      command: "source link",
      code: "source_item_not_found",
      sourceItemId: "source_item_missing",
      goalId: goalAId
    });

    const linkA = await run([
      "source", "link", sourceItemId,
      "--goal", goalAId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(linkA.code).toBe(0);

    const collision = await run([
      "source", "link", sourceItemId,
      "--goal", goalBId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(collision.code).toBe(1);
    const collisionPayload = JSON.parse(collision.stderr) as Record<string, unknown>;
    expect(collisionPayload).toMatchObject({
      ok: false,
      command: "source link",
      code: "linked_to_other_goal",
      sourceItemId,
      goalId: goalBId,
      currentGoalId: goalAId
    });
  });

  it("source unlink clears the link idempotently and surfaces source_item_not_found", async () => {
    const dataDir = makeTempDir("momentum-cli-source-unlink-");
    const goalId = "goal-unlink-target";

    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    let sourceItemId: string;
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(goalId, "Unlink target goal", "momentum/unlink-target", "/tmp/unlink-target", 1, 1);
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "local-fixture",
          externalId: "fixture-unlink-1",
          externalKey: "SRC-UNLINK-1",
          title: "Unlinkable source item",
          status: "Todo",
          observedAt: 1_700_000_000_000,
          goalId
        },
        { now: () => 1_700_000_000_100 }
      );
      sourceItemId = item.id;
    } finally {
      db.close();
    }

    const firstUnlink = await run([
      "source", "unlink", sourceItemId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(firstUnlink.code).toBe(0);
    const firstPayload = JSON.parse(firstUnlink.stdout) as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      ok: true,
      command: "source unlink",
      sourceItemId,
      changed: true,
      previousGoalId: goalId
    });

    const secondUnlink = await run([
      "source", "unlink", sourceItemId,
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(secondUnlink.code).toBe(0);
    const secondPayload = JSON.parse(secondUnlink.stdout) as Record<string, unknown>;
    expect(secondPayload).toMatchObject({
      ok: true,
      command: "source unlink",
      sourceItemId,
      changed: false,
      previousGoalId: null
    });

    const missing = await run([
      "source", "unlink", "source_item_missing",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(missing.code).toBe(1);
    const missingPayload = JSON.parse(missing.stderr) as Record<string, unknown>;
    expect(missingPayload).toMatchObject({
      ok: false,
      command: "source unlink",
      code: "source_item_not_found",
      sourceItemId: "source_item_missing"
    });
  });

  it("help lists the new recovery clear command", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]"
    );
  });

  it("source reconcile linear --dry-run records an audit-only run without writing items", async () => {
    const dataDir = makeTempDir("momentum-cli-source-reconcile-dry-");
    const fakeIssue = {
      id: "lin-1",
      identifier: "NGX-DR-1",
      title: "Dry-run linear issue",
      url: "https://linear.app/example/issue/NGX-DR-1",
      state: { id: "state-1", name: "In Progress" },
      project: { id: "project-1", name: "Project One" },
      projectMilestone: { id: "milestone-1", name: "Milestone One" },
      labels: { nodes: [] },
      assignee: null,
      priority: 0,
      updatedAt: "2026-04-01T00:00:00.000Z"
    };
    const factoryCalls: Array<{ apiKey: string | null; endpoint: string | null }> = [];
    const fetchCalls: Array<{ filters: Record<string, unknown> }> = [];
    const deps = {
      buildLinearReconciliationClient: (input: {
        apiKey: string | null;
        endpoint: string | null;
      }) => {
        factoryCalls.push({ apiKey: input.apiKey, endpoint: input.endpoint });
        return {
          fetchPage: async (input: { filters: Record<string, unknown> }) => {
            fetchCalls.push({ filters: input.filters });
            return {
              ok: true as const,
              page: { issues: [fakeIssue], nextCursor: null }
            };
          }
        };
      }
    };

    const result = await runWithDeps(
      [
        "source",
        "reconcile",
        "linear",
        "--dry-run",
        "--project",
        "Project One",
        "--milestone",
        "Milestone One",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "source reconcile linear",
      adapter: "linear",
      dryRun: true,
      counts: { itemsObserved: 1, itemsCreated: 1 }
    });
    const run0 = payload["run"] as Record<string, unknown>;
    expect(run0["state"]).toBe("succeeded");
    expect(run0["adapterKind"]).toBe("linear");
    const itemsSampled = payload["itemsSampled"] as Array<Record<string, unknown>>;
    expect(itemsSampled[0]).toMatchObject({
      classification: "created",
      externalKey: "NGX-DR-1"
    });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.apiKey).toBe("test-key");
    expect(fetchCalls).toEqual([
      {
        filters: {
          projectName: "Project One",
          milestoneName: "Milestone One"
        }
      }
    ]);

    const { openDb } = await import("../src/adapters/db.js");
    const { listSourceItems } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      expect(listSourceItems(db, { adapterKind: "linear" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("source reconcile linear live path upserts items and surfaces them via source list + doctor", async () => {
    const dataDir = makeTempDir("momentum-cli-source-reconcile-live-");
    const fakeIssue = {
      id: "lin-live-1",
      identifier: "NGX-LV-1",
      title: "Live linear issue",
      url: "https://linear.app/example/issue/NGX-LV-1",
      state: { id: "state-2", name: "Todo" },
      project: { id: "project-1", name: "Project One" },
      projectMilestone: { id: "milestone-1", name: "Milestone One" },
      labels: { nodes: [{ id: "label-1", name: "infra" }] },
      assignee: null,
      priority: 1,
      updatedAt: "2026-04-02T00:00:00.000Z"
    };
    const deps = {
      buildLinearReconciliationClient: () => ({
        fetchPage: async () => ({
          ok: true as const,
          page: { issues: [fakeIssue], nextCursor: null }
        })
      })
    };

    const reconcile = await runWithDeps(
      [
        "source",
        "reconcile",
        "linear",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );
    expect(reconcile.code).toBe(0);
    const reconcilePayload = JSON.parse(reconcile.stdout) as Record<string, unknown>;
    expect(reconcilePayload).toMatchObject({
      ok: true,
      command: "source reconcile linear",
      dryRun: false,
      counts: { itemsObserved: 1, itemsCreated: 1 }
    });

    const listResult = await run([
      "source",
      "list",
      "--adapter",
      "linear",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(listResult.code).toBe(0);
    const listPayload = JSON.parse(listResult.stdout) as Record<string, unknown>;
    expect(listPayload).toMatchObject({
      ok: true,
      count: 1,
      lastReconciliation: { state: "succeeded", itemsSeen: 1, itemsUpserted: 1 }
    });
    const items = listPayload["items"] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      adapterKind: "linear",
      externalId: "lin-live-1",
      externalKey: "NGX-LV-1",
      title: "Live linear issue",
      status: "Todo"
    });

    const doctorResult = await run([
      "doctor",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(doctorResult.code).toBe(0);
    const doctorPayload = JSON.parse(doctorResult.stdout) as Record<string, unknown>;
    const sources = doctorPayload["sources"] as Record<string, unknown>;
    expect(sources).toMatchObject({
      ok: true,
      lastReconciliation: { adapterKind: "linear", state: "succeeded" }
    });
  });

  it("source list and doctor surface capped Linear reconciliation stop reasons", async () => {
    const dataDir = makeTempDir("momentum-cli-source-reconcile-capped-");
    const issueA = {
      id: "lin-cap-1",
      identifier: "NGX-CAP-1",
      title: "First capped issue",
      url: "https://linear.app/example/issue/NGX-CAP-1",
      state: { id: "state-1", name: "Todo" },
      project: { id: "project-1", name: "Project One" },
      projectMilestone: null,
      labels: { nodes: [] },
      assignee: null,
      priority: 0,
      updatedAt: "2026-04-02T00:00:00.000Z"
    };
    const issueB = {
      ...issueA,
      id: "lin-cap-2",
      identifier: "NGX-CAP-2",
      title: "Second capped issue",
      updatedAt: "2026-04-03T00:00:00.000Z"
    };
    let pageIndex = 0;
    const deps = {
      buildLinearReconciliationClient: () => ({
        fetchPage: async () => {
          pageIndex += 1;
          return pageIndex === 1
            ? { ok: true as const, page: { issues: [issueA], nextCursor: "next-page" } }
            : { ok: true as const, page: { issues: [issueB], nextCursor: null } };
        }
      })
    };

    const reconcile = await runWithDeps(
      [
        "source",
        "reconcile",
        "linear",
        "--data-dir",
        dataDir,
        "--max-pages",
        "1",
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );
    expect(reconcile.code).toBe(0);
    const reconcilePayload = JSON.parse(reconcile.stdout) as Record<string, unknown>;
    expect(reconcilePayload).toMatchObject({
      ok: true,
      run: { state: "succeeded" },
      paginationStopped: { reason: "max_pages", pageIndex: 1 }
    });

    const listJson = await run([
      "source",
      "list",
      "--adapter",
      "linear",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(listJson.code).toBe(0);
    const listPayload = JSON.parse(listJson.stdout) as Record<string, unknown>;
    expect(listPayload).toMatchObject({
      ok: true,
      count: 1,
      lastReconciliation: {
        state: "succeeded",
        paginationStopped: { reason: "max_pages", pageIndex: 1 }
      }
    });

    const listText = await run([
      "source",
      "list",
      "--adapter",
      "linear",
      "--data-dir",
      dataDir
    ]);
    expect(listText.code).toBe(0);
    expect(listText.stdout).toContain("Last reconciliation: linear succeeded");
    expect(listText.stdout).toContain("stopped=max_pages");

    const doctorJson = await run(["doctor", "--data-dir", dataDir, "--json"]);
    expect(doctorJson.code).toBe(0);
    const doctorPayload = JSON.parse(doctorJson.stdout) as Record<string, unknown>;
    expect(doctorPayload).toMatchObject({
      sources: {
        ok: true,
        lastReconciliation: {
          adapterKind: "linear",
          state: "succeeded",
          paginationStopped: { reason: "max_pages", pageIndex: 1 }
        }
      }
    });

    const doctorText = await run(["doctor", "--data-dir", dataDir]);
    expect(doctorText.code).toBe(0);
    expect(doctorText.stdout).toContain("sources: last linear reconciliation succeeded");
    expect(doctorText.stdout).toContain("stopped=max_pages");
  });

  it("source reconcile linear without LINEAR_API_KEY returns source_auth_unavailable from the default client", async () => {
    const dataDir = makeTempDir("momentum-cli-source-reconcile-noauth-");
    const result = await runWithDeps(
      [
        "source",
        "reconcile",
        "linear",
        "--data-dir",
        dataDir,
        "--json"
      ],
      {},
      {}
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "source reconcile linear",
      adapter: "linear"
    });
    const paginationStopped = payload["paginationStopped"] as Record<string, unknown>;
    expect(paginationStopped).toMatchObject({
      reason: "auth_unavailable",
      code: "source_auth_unavailable"
    });
    const runPayload = payload["run"] as Record<string, unknown>;
    expect(runPayload["state"]).toBe("failed");
  });

  it("source reconcile rejects unknown adapter kinds with unsupported_source_adapter", async () => {
    const dataDir = makeTempDir("momentum-cli-source-reconcile-bad-");
    const result = await runWithDeps(
      [
        "source",
        "reconcile",
        "github",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "x" },
      {}
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "source reconcile linear",
      code: "unsupported_source_adapter"
    });
  });
});

describe("momentum CLI external apply post-apply reconciliation", () => {
  async function seedExternalApplyFixture(dataDir: string): Promise<string> {
    const { openDb } = await import("../src/adapters/db.js");
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES (?, 'linear', ?, 'NGX-CLI', ?, 'CLI issue', 'Todo', '{}',
                 1, NULL, 1, 1)`
      ).run(
        "source_cli_external_apply",
        "linear-issue-cli",
        "https://linear.app/example/issue/NGX-CLI"
      );
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES (?, 'linear', ?, 'source_satisfied', '{"kind":"comment"}',
                 'evidence says done', ?, 'pending', ?, 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run(
        "intent_cli_external_apply",
        "linear-issue-cli",
        "source_cli_external_apply",
        "idemp:intent_cli_external_apply"
      );
    } finally {
      db.close();
    }
    return "intent_cli_external_apply";
  }

  function makeExternalApplyDeps(reconcileComment: () => string) {
    let marker = "";
    return {
      buildLinearExternalUpdateClient: () => ({
        async apply(input: { preview: { idempotencyMarker: string } }) {
          marker = input.preview.idempotencyMarker;
          return {
            ok: true as const,
            alreadyApplied: false,
            issue: {
              id: "linear-issue-cli",
              key: "NGX-CLI",
              url: "https://linear.app/example/issue/NGX-CLI"
            },
            comment: {
              id: "comment-cli",
              url: "https://linear.app/example/comment/cli"
            },
            status: {
              transitioned: false as const,
              previousStateId: "state-todo",
              previousStateName: "Todo",
              nextStateId: null,
              nextStateName: null
            },
            idempotencyMarker: marker
          };
        }
      }),
      buildLinearIssueRefreshClient: () => ({
        async refresh() {
          return {
            ok: true as const,
            issue: {
              id: "linear-issue-cli",
              identifier: "NGX-CLI",
              title: "CLI issue",
              url: "https://linear.app/example/issue/NGX-CLI",
              updatedAt: "2026-05-21T00:00:00.000Z",
              state: { id: "state-done", name: "Done" }
            },
            comments: [
              {
                id: "comment-cli",
                body: reconcileComment().replace("{marker}", marker),
                url: "https://linear.app/example/comment/cli"
              }
            ]
          };
        }
      })
    };
  }

  it("intent apply --external-apply --json persists and returns reconcile success", async () => {
    const dataDir = makeTempDir("momentum-cli-external-apply-json-");
    const repo = makeTempDir("momentum-cli-external-apply-repo-");
    fs.writeFileSync(
      path.join(repo, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf-8"
    );
    const intentId = await seedExternalApplyFixture(dataDir);

    const result = await runWithDeps(
      [
        "intent", "apply", intentId,
        "--reason", "operator verified",
        "--external-apply",
        "--repo", repo,
        "--data-dir", dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      makeExternalApplyDeps(() => "Applied {marker}")
    );

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const externalApply = payload["externalApply"] as Record<string, unknown>;
    expect(externalApply["reconcile"]).toEqual({
      status: "success",
      warning: null
    });

    const { getLatestIntentApplyAudit } = await import(
      "../src/core/intent/apply-audits.js"
    );
    const { openDb } = await import("../src/adapters/db.js");
    const db = openDb(dataDir);
    try {
      const audit = getLatestIntentApplyAudit(db, intentId);
      expect(audit?.reconcile).toEqual({ status: "success", warning: null });
    } finally {
      db.close();
    }
  });

  it("intent apply --external-apply text output surfaces reconcile warnings", async () => {
    const dataDir = makeTempDir("momentum-cli-external-apply-text-");
    const repo = makeTempDir("momentum-cli-external-apply-repo-");
    fs.writeFileSync(
      path.join(repo, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf-8"
    );
    const intentId = await seedExternalApplyFixture(dataDir);

    const result = await runWithDeps(
      [
        "intent", "apply", intentId,
        "--reason", "operator verified",
        "--external-apply",
        "--repo", repo,
        "--data-dir", dataDir
      ],
      { LINEAR_API_KEY: "test-key" },
      makeExternalApplyDeps(() => "unrelated comment")
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("External apply: performed");
    expect(result.stdout).toContain("Reconcile: mismatch_persists");
    expect(result.stdout).toContain("did not surface idempotency marker");
  });
});

describe("momentum project status", () => {
  it("returns a stable empty rollup JSON shape on a fresh data dir", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");

    const result = await run([
      "project", "status", "--data-dir", dataDir, "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "project status",
      dataDir,
      filters: {
        source: null,
        projectId: null,
        projectName: null,
        milestoneId: null,
        milestoneName: null
      },
      staleThresholdMs: 24 * 60 * 60 * 1000,
      totalSourceItemCount: 0,
      truncatedSourceItems: false,
      sourceItems: [],
      mismatches: [],
      totalMismatchCount: 0,
      truncatedMismatches: false,
      reconciliationWarnings: [],
      pendingUpdateIntents: []
    });
    expect((payload["counts"] as Record<string, unknown>)["pendingUpdateIntents"]).toBe(0);
    expect((payload["nextAction"] as Record<string, unknown>)["kind"]).toBe(
      "no_action_required"
    );
    expect(result.stderr).toBe("");
  });

  it("echoes filter values back when --source, --project, and --milestone are passed", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-filter-1",
          externalKey: "NGX-FILTER-1",
          title: "Filter test issue",
          status: "Todo",
          metadata: {
            project: { id: "proj-1", name: "Alpha" },
            milestone: { id: "ms-1", name: "Mile 1" }
          },
          observedAt: 1_700_000_000_000,
          goalId: null
        },
        { now: () => 1_700_000_000_100 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status",
      "--source", "linear",
      "--project", "Alpha",
      "--milestone", "Mile 1",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["filters"]).toEqual({
      source: "linear",
      projectId: "Alpha",
      projectName: "Alpha",
      milestoneId: "Mile 1",
      milestoneName: "Mile 1"
    });
    expect((payload["counts"] as Record<string, unknown>)["sourceItems"]).toMatchObject({
      total: 1
    });
  });

  it("dedupes duplicate Linear rows by externalKey in project status JSON output", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "NGX-543",
          externalKey: "NGX-543",
          title: "Legacy stale issue",
          status: "In Review",
          metadata: {
            project: { id: "proj-momentum", name: "Momentum" }
          },
          observedAt: 1_700_000_000_000,
          goalId: null
        },
        { now: () => 1_700_000_000_100 }
      );
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "00000000-0000-4000-8000-000000000003",
          externalKey: "NGX-543",
          title: "Canonical fresh issue",
          status: "Done",
          metadata: {
            project: { id: "proj-momentum", name: "Momentum" }
          },
          observedAt: 1_700_000_000_200,
          goalId: null
        },
        { now: () => 1_700_000_000_200 }
      );
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "00000000-0000-4000-8000-000000000004",
          externalKey: "NGX-543",
          title: "Canonical newer issue",
          status: "Todo",
          metadata: {
            project: { id: "proj-momentum", name: "Momentum" }
          },
          observedAt: 1_700_000_000_400,
          goalId: null
        },
        { now: () => 1_700_000_000_400 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status",
      "--source", "linear",
      "--project", "Momentum",
      "--intent-stale-threshold-days", "0",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const sourceItems = payload["sourceItems"] as Array<Record<string, unknown>>;
    expect(sourceItems).toHaveLength(1);
    expect(sourceItems[0]?.["externalId"]).toBe("00000000-0000-4000-8000-000000000004");
    expect(sourceItems[0]?.["status"]).toBe("Todo");
    expect((payload["counts"] as Record<string, unknown>)["sourceItems"]).toMatchObject({
      total: 1
    });
  });

  it("matches --project and --milestone against non-UUID metadata ids", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-filter-id-1",
          externalKey: "NGX-FILTER-ID-1",
          title: "Filter id test issue",
          status: "Todo",
          metadata: {
            project: { id: "proj-1", name: "Alpha" },
            milestone: { id: "ms-1", name: "Mile 1" }
          },
          observedAt: 1_700_000_000_000,
          goalId: null
        },
        { now: () => 1_700_000_000_100 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status",
      "--source", "linear",
      "--project", "proj-1",
      "--milestone", "ms-1",
      "--data-dir", dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["filters"]).toEqual({
      source: "linear",
      projectId: "proj-1",
      projectName: "proj-1",
      milestoneId: "ms-1",
      milestoneName: "ms-1"
    });
    expect((payload["counts"] as Record<string, unknown>)["sourceItems"]).toMatchObject({
      total: 1
    });
  });

  it("applies --stale-threshold-hours to reconciliation warning detection", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const {
      startSourceReconciliationRun,
      finishSourceReconciliationRun
    } = await import("../src/core/source/reconciliation-runs.js");
    const db = openDb(dataDir);
    try {
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-stale-cli-1",
          externalKey: null,
          title: "Stale issue",
          status: "Todo",
          metadata: {},
          observedAt: 1_000,
          goalId: null
        },
        { now: () => 1_000 }
      );
      const longAgo = Date.now() - 48 * 60 * 60 * 1000;
      const reconRun = startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => longAgo }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: reconRun.id,
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        },
        { now: () => longAgo + 1_000 }
      );
    } finally {
      db.close();
    }

    const generous = await run([
      "project", "status",
      "--stale-threshold-hours", "72",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(generous.code).toBe(0);
    const generousPayload = JSON.parse(generous.stdout) as Record<string, unknown>;
    expect(generousPayload["staleThresholdMs"]).toBe(72 * 60 * 60 * 1000);
    expect(generousPayload["reconciliationWarnings"]).toEqual([]);

    const tight = await run([
      "project", "status",
      "--stale-threshold-hours", "1",
      "--data-dir", dataDir,
      "--json"
    ]);
    const tightPayload = JSON.parse(tight.stdout) as Record<string, unknown>;
    const warnings = tightPayload["reconciliationWarnings"] as Array<{
      reason: string;
      adapterKind: string;
    }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toBe("stale");
    expect(warnings[0]?.adapterKind).toBe("linear");
  });

  it("surfaces manual_recovery_required as the highest-priority next action", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, state, current_iteration,
            needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "goal-recover-cli",
        "Recover CLI Goal",
        "momentum/goal-recover-cli",
        path.join(dataDir, "goals", "goal-recover-cli"),
        "queued",
        1,
        1,
        "head_mismatch",
        1_700_000_000_500,
        1_700_000_000_000,
        1_700_000_000_500
      );
      upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-recover-cli",
          externalKey: "NGX-RECOVER",
          title: "Recover linked",
          status: "In Progress",
          metadata: {},
          observedAt: 1_700_000_000_000,
          goalId: "goal-recover-cli"
        },
        { now: () => 1_700_000_000_100 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status", "--data-dir", dataDir, "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const counts = payload["counts"] as Record<string, unknown>;
    expect((counts["goals"] as Record<string, unknown>)["needingManualRecovery"]).toBe(1);
    expect((payload["nextAction"] as Record<string, unknown>)["kind"]).toBe(
      "manual_recovery_required"
    );
    const mismatchKinds = (payload["mismatches"] as Array<{ kind: string }>).map(
      (m) => m.kind
    );
    expect(mismatchKinds).toContain("manual_recovery_required");
  });

  it("text mode truncates large source item lists with an `and N more` line", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const db = openDb(dataDir);
    try {
      for (let i = 0; i < 25; i += 1) {
        const key = `NGX-BIG-${String(i).padStart(3, "0")}`;
        upsertSourceItem(
          db,
          {
            adapterKind: "linear",
            externalId: `issue-big-${i}`,
            externalKey: key,
            title: `Big issue ${i}`,
            status: "Todo",
            metadata: {},
            observedAt: 1_700_000_000_000 + i,
            goalId: null
          },
          { now: () => 1_700_000_000_000 + i }
        );
      }
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status", "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Project status");
    expect(result.stdout).toContain("Source items: 25");
    expect(result.stdout).toContain("Top source items:");
    expect(result.stdout).toContain("... and 5 more");
    expect(result.stdout).toContain("Next action:");
    expect(result.stderr).toBe("");
  });

  it("rejects unexpected positional arguments for project status", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");

    const result = await run([
      "project", "status", "stray-arg", "--data-dir", dataDir, "--json"
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unexpected argument for project status: stray-arg");
  });

  it("rejects unknown project subcommands", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");

    const result = await run([
      "project", "explode", "--data-dir", dataDir
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown project subcommand: explode");
  });

  it("requires a project subcommand", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");

    const result = await run(["project", "--data-dir", dataDir]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Missing required subcommand for project. Expected: status."
    );
  });

  it("rejects --stale-threshold-hours without a numeric value", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");

    const result = await run([
      "project", "status",
      "--stale-threshold-hours", "not-a-number",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--stale-threshold-hours");
  });

  it("surfaces pending update intents in the project status JSON payload", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const db = openDb(dataDir);
    const recentNow = Date.now();
    try {
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-cli-intent",
          externalKey: "NGX-CLI-INTENT",
          title: "CLI intent issue",
          status: "In Progress",
          metadata: {},
          observedAt: recentNow,
          goalId: null
        },
        { now: () => recentNow }
      );
      createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "source_satisfied",
          reason: "Goal completed",
          targetExternalId: "issue-cli-intent",
          sourceItemId: item.id,
          idempotencyKey: "linear:issue-cli-intent:source_satisfied:cli"
        },
        { now: () => recentNow }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status", "--data-dir", dataDir, "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const intents = payload["pendingUpdateIntents"] as Array<Record<string, unknown>>;
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      adapterKind: "linear",
      intentType: "source_satisfied",
      targetExternalId: "issue-cli-intent",
      stale: false
    });
    expect((payload["counts"] as Record<string, unknown>)["pendingUpdateIntents"]).toBe(1);
    expect((payload["counts"] as Record<string, unknown>)["staleUpdateIntents"]).toBe(0);
    expect(payload["intentStaleThresholdMs"]).toBe(30 * 24 * 60 * 60 * 1000);
    expect(payload["totalPendingUpdateIntentCount"]).toBe(1);
    expect(payload["truncatedPendingUpdateIntents"]).toBe(false);
  });

  it("surfaces pending intents for legacy scalar project and milestone metadata", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const db = openDb(dataDir);
    const recentNow = Date.now();
    try {
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-cli-legacy-metadata",
          externalKey: "NGX-LEGACY-META",
          title: "Legacy metadata pending intent",
          status: "In Progress",
          metadata: {
            project: "Momentum",
            milestone: "Momentum-Native Coding Workflow Adoption"
          },
          observedAt: recentNow,
          goalId: null
        },
        { now: () => recentNow }
      );
      createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "source_satisfied",
          reason: "Legacy metadata should still be surfaced",
          targetExternalId: "NGX-LEGACY-META",
          sourceItemId: item.id,
          idempotencyKey:
            "linear:issue-cli-legacy-metadata:source_satisfied:legacy"
        },
        { now: () => recentNow }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status",
      "--source", "linear",
      "--project", "Momentum",
      "--milestone", "Momentum-Native Coding Workflow Adoption",
      "--intent-stale-threshold-days", "0",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const intents = payload["pendingUpdateIntents"] as Array<Record<string, unknown>>;
    expect(intents).toHaveLength(1);
    expect(payload["filters"]).toMatchObject({
      source: "linear",
      projectName: "Momentum",
      milestoneName: "Momentum-Native Coding Workflow Adoption"
    });
    expect((payload["counts"] as Record<string, unknown>)["pendingUpdateIntents"]).toBe(1);
    expect((payload["nextAction"] as Record<string, unknown>)["kind"]).toBe(
      "review_pending_intents"
    );
  });

  it("surfaces an empty external apply rollup when no audits exist", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const db = openDb(dataDir);
    const recentNow = Date.now();
    try {
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-no-audit",
          externalKey: "NGX-NO-AUDIT",
          title: "No-audit issue",
          status: "In Progress",
          metadata: {},
          observedAt: recentNow,
          goalId: null
        },
        { now: () => recentNow }
      );
      createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "source_satisfied",
          reason: "Goal completed",
          targetExternalId: "issue-no-audit",
          sourceItemId: item.id,
          idempotencyKey: "linear:issue-no-audit:source_satisfied:cli"
        },
        { now: () => recentNow }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status", "--data-dir", dataDir, "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const externalApply = payload["externalApply"] as Record<string, unknown>;
    expect(externalApply).toMatchObject({
      pendingIntentApplyStateCounts: { idle: 1, in_flight: 0, blocked: 0 },
      pendingAuditCounts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      totalAttempts: 0,
      latestAttempt: null
    });
    const intents = payload["pendingUpdateIntents"] as Array<Record<string, unknown>>;
    expect(intents).toHaveLength(1);
    expect(intents[0]?.["externalApply"]).toEqual({
      applyState: "idle",
      totalAttempts: 0,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      latestAttempt: null
    });

    const text = await run([
      "project", "status", "--data-dir", dataDir
    ]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      "Pending external apply state: idle=1, in_flight=0, blocked=0"
    );
    expect(text.stdout).toContain(
      "Pending external apply audits: total=0, succeeded=0, failed=0, claimed=0, blocked=0, audit_incomplete=0"
    );
    expect(text.stdout).toContain("Latest external apply: (none)");
    expect(text.stdout).toContain("apply=idle attempts=0");
  });

  it("aggregates per-intent audit surfaces in project status JSON and text output", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const { claimIntentApply, finalizeIntentApply } = await import(
      "../src/core/intent/apply-audits.js"
    );
    const db = openDb(dataDir);
    const recentNow = 1_700_000_000_000;
    let succeededIntentId = "";
    let blockedIntentId = "";
    try {
      const itemSucceeded = upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-succeeded",
          externalKey: "NGX-SUCCEEDED",
          title: "Succeeded issue",
          status: "In Progress",
          metadata: {},
          observedAt: recentNow,
          goalId: null
        },
        { now: () => recentNow }
      );
      const succeeded = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "source_satisfied",
          reason: "Goal completed",
          targetExternalId: "issue-succeeded",
          sourceItemId: itemSucceeded.id,
          idempotencyKey: "linear:issue-succeeded:source_satisfied:cli"
        },
        { now: () => recentNow }
      );
      succeededIntentId = succeeded.intent.id;
      const itemBlocked = upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-blocked",
          externalKey: "NGX-BLOCKED",
          title: "Blocked issue",
          status: "In Progress",
          metadata: {},
          observedAt: recentNow + 1,
          goalId: null
        },
        { now: () => recentNow + 1 }
      );
      const blocked = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "comment_requested",
          reason: "Followup",
          targetExternalId: "issue-blocked",
          sourceItemId: itemBlocked.id,
          idempotencyKey: "linear:issue-blocked:comment_requested:cli"
        },
        { now: () => recentNow + 1 }
      );
      blockedIntentId = blocked.intent.id;

      const claimSucceeded = claimIntentApply(db, {
        intentId: succeededIntentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "issue-succeeded",
          externalKey: "NGX-SUCCEEDED",
          url: "https://linear.app/example/issue/issue-succeeded",
          title: "Succeeded issue"
        },
        operatorReason: "verified done",
        operatorActor: "operator@example.com",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment: source_satisfied",
        idempotencyMarker: `momentum-intent:linear:${succeededIntentId}:deadbeef`,
        now: recentNow + 10
      });
      if (!claimSucceeded.ok) {
        throw new Error(
          `seed: claim succeeded failed (${claimSucceeded.code})`
        );
      }
      const finalizeSucceeded = finalizeIntentApply(db, {
        auditId: claimSucceeded.audit.id,
        lifecycleState: "succeeded",
        resultStatus: "ok",
        resultCode: "ok",
        resultMessage: "wrote comment",
        externalRefs: {
          commentId: "linear_comment_ok",
          commentUrl: "https://linear.app/example/issue/issue-succeeded#c1",
          stateTransitionId: null
        },
        now: recentNow + 11
      });
      if (!finalizeSucceeded.ok) {
        throw new Error(
          `seed: finalize succeeded failed (${finalizeSucceeded.code})`
        );
      }

      const claimBlocked = claimIntentApply(db, {
        intentId: blockedIntentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "issue-blocked",
          externalKey: "NGX-BLOCKED",
          url: "https://linear.app/example/issue/issue-blocked",
          title: "Blocked issue"
        },
        operatorReason: "needs followup",
        operatorActor: "operator@example.com",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment: comment_requested",
        idempotencyMarker: `momentum-intent:linear:${blockedIntentId}:deadbeef`,
        now: recentNow + 20
      });
      if (!claimBlocked.ok) {
        throw new Error(
          `seed: claim blocked failed (${claimBlocked.code})`
        );
      }
      const finalizeBlocked = finalizeIntentApply(db, {
        auditId: claimBlocked.audit.id,
        lifecycleState: "audit_incomplete",
        resultStatus: "wrote_no_audit",
        resultCode: "audit_finalize_failed",
        resultMessage: "linear succeeded but audit could not be finalized",
        externalRefs: {
          commentId: "linear_comment_late",
          commentUrl: "https://linear.app/example/issue/issue-blocked#c2",
          stateTransitionId: null
        },
        now: recentNow + 21
      });
      if (!finalizeBlocked.ok) {
        throw new Error(
          `seed: finalize blocked failed (${finalizeBlocked.code})`
        );
      }
    } finally {
      db.close();
    }

    const json = await run([
      "project", "status", "--data-dir", dataDir, "--json"
    ]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as Record<string, unknown>;
    const externalApply = payload["externalApply"] as Record<string, unknown>;
    expect(externalApply).toMatchObject({
      pendingIntentApplyStateCounts: { idle: 1, in_flight: 0, blocked: 1 },
      pendingAuditCounts: {
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 1
      },
      totalAttempts: 2
    });
    const latest = externalApply["latestAttempt"] as Record<string, unknown>;
    expect(latest["intentId"]).toBe(blockedIntentId);
    expect(latest["lifecycleState"]).toBe("audit_incomplete");
    expect(latest["resultCode"]).toBe("audit_finalize_failed");

    const intents = payload["pendingUpdateIntents"] as Array<Record<string, unknown>>;
    expect(intents).toHaveLength(2);
    const succeededRow = intents.find(
      (intent) => intent["intentId"] === succeededIntentId
    );
    expect(succeededRow?.["externalApply"]).toMatchObject({
      applyState: "idle",
      totalAttempts: 1,
      counts: {
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      }
    });
    const succeededLatest = (succeededRow?.["externalApply"] as Record<string, unknown>)[
      "latestAttempt"
    ] as Record<string, unknown>;
    expect(succeededLatest["lifecycleState"]).toBe("succeeded");
    expect(succeededLatest["resultCode"]).toBe("ok");

    const blockedRow = intents.find(
      (intent) => intent["intentId"] === blockedIntentId
    );
    expect(blockedRow?.["externalApply"]).toMatchObject({
      applyState: "blocked",
      totalAttempts: 1,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 1
      }
    });

    const text = await run([
      "project", "status", "--data-dir", dataDir
    ]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      "Pending external apply state: idle=1, in_flight=0, blocked=1"
    );
    expect(text.stdout).toContain(
      "Pending external apply audits: total=2, succeeded=1, failed=0, claimed=0, blocked=0, audit_incomplete=1"
    );
    expect(text.stdout).toContain(
      `Latest external apply: ${latest["id"]} audit_incomplete intent=${blockedIntentId}`
    );
    expect(text.stdout).toContain("apply=idle attempts=1 latest=succeeded");
    expect(text.stdout).toContain("apply=blocked attempts=1 latest=audit_incomplete");
  });

  it("honors --intent-stale-threshold-days to flag pending intents stale", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");
    const { openDb } = await import("../src/adapters/db.js");
    const { upsertSourceItem } = await import("../src/core/source/items.js");
    const { createUpdateIntent } = await import("../src/core/intent/update-intents.js");
    const db = openDb(dataDir);
    try {
      const item = upsertSourceItem(
        db,
        {
          adapterKind: "linear",
          externalId: "issue-cli-stale",
          externalKey: "NGX-CLI-STALE",
          title: "Stale intent issue",
          status: "In Progress",
          metadata: {},
          observedAt: 1_000,
          goalId: null
        },
        { now: () => 1_000 }
      );
      createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "source_satisfied",
          reason: "Older intent",
          sourceItemId: item.id,
          idempotencyKey: "linear:issue-cli-stale:source_satisfied:cli"
        },
        { now: () => 1_000 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "project", "status",
      "--intent-stale-threshold-days", "0",
      "--data-dir", dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["intentStaleThresholdMs"]).toBe(0);
    expect((payload["counts"] as Record<string, unknown>)["staleUpdateIntents"]).toBe(1);
    const intents = payload["pendingUpdateIntents"] as Array<Record<string, unknown>>;
    expect(intents[0]?.["stale"]).toBe(true);
  });

  it("rejects --intent-stale-threshold-days without a numeric value", async () => {
    const dataDir = makeTempDir("momentum-cli-project-");

    const result = await run([
      "project", "status",
      "--intent-stale-threshold-days", "not-a-number",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--intent-stale-threshold-days");
  });
});

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";

  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });

  return { code, stdout, stderr };
}

async function runWithDeps(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: Parameters<typeof runCli>[2]
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";

  const code = await runCli(
    argv,
    {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        }
      },
      env
    },
    deps
  );

  return { code, stdout, stderr };
}
