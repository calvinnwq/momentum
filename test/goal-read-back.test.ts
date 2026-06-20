/**
 * Focused unit coverage for the shared goal-first read-back primitives
 * (RC-1c, NGX-495). `loadGoalStatus` and `loadGoalLogs` both compose these, so
 * this pins the resolution decision (explicit hit / `goal_not_found` /
 * `no_goals`), the latest-goal default target, and the evidence projection that
 * each loader previously owned a private copy of.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { initGoal } from "../src/core/goal/init.js";
import type { EvidenceRecord } from "../src/core/evidence/records.js";
import {
  findLatestGoal,
  resolveGoalForReadBack,
  toGoalEvidenceSummary
} from "../src/core/goal/read-back.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-readback-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir("momentum-readback-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function seedGoal(dataDir: string, title: string): string {
  const repo = initRepo();
  const specDir = makeTempDir("momentum-readback-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    `---
title: ${title}
repo: ${repo}
runner: fake
verification:
  - true
---
Apply the fixture file deterministically.
`,
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir },
    mode: "queued"
  });
  if (!init.ok) throw new Error(`initGoal failed: ${init.error}`);
  return init.goalId;
}

function setGoalCreatedAt(db: MomentumDb, goalId: string, createdAt: number): void {
  const info = db
    .prepare("UPDATE goals SET created_at = ? WHERE id = ?")
    .run(createdAt, goalId);
  if (info.changes < 1) throw new Error(`goal ${goalId} not found to stamp`);
}

function makeEvidenceRecord(
  overrides: Partial<EvidenceRecord> = {}
): EvidenceRecord {
  return {
    id: "ev-1",
    source: "runner",
    type: "iteration_result",
    formatVersion: 2,
    artifactPath: "/data/goals/g/iterations/1/result.json",
    externalId: "ext-9",
    occurredAt: 1_700_000_000_000,
    summary: "iteration completed",
    metadata: { secret: "kept-internal" },
    goalId: "g",
    sourceItemId: "si-1",
    runId: "run-1",
    stepId: "step-1",
    ingestKey: "ingest-1",
    createdAt: 1_700_000_000_500,
    updatedAt: 1_700_000_000_600,
    ...overrides
  };
}

describe("toGoalEvidenceSummary", () => {
  it("projects exactly the eight read-back fields and drops internal columns", () => {
    const summary = toGoalEvidenceSummary(makeEvidenceRecord());

    expect(summary).toEqual({
      id: "ev-1",
      source: "runner",
      type: "iteration_result",
      formatVersion: 2,
      occurredAt: 1_700_000_000_000,
      summary: "iteration completed",
      artifactPath: "/data/goals/g/iterations/1/result.json",
      sourceItemId: "si-1"
    });
    // Internal/linkage columns must not leak into the read-back envelope.
    expect(Object.keys(summary)).not.toContain("metadata");
    expect(Object.keys(summary)).not.toContain("externalId");
    expect(Object.keys(summary)).not.toContain("goalId");
    expect(Object.keys(summary)).not.toContain("runId");
    expect(Object.keys(summary)).not.toContain("ingestKey");
  });

  it("preserves a null artifact path", () => {
    const summary = toGoalEvidenceSummary(
      makeEvidenceRecord({ artifactPath: null, sourceItemId: null })
    );
    expect(summary.artifactPath).toBeNull();
    expect(summary.sourceItemId).toBeNull();
  });
});

describe("resolveGoalForReadBack", () => {
  it("resolves an explicit goal id", () => {
    const dataDir = makeTempDir();
    const goalId = seedGoal(dataDir, "explicit target");
    const db = openDb(dataDir);
    try {
      const resolved = resolveGoalForReadBack(db, dataDir, goalId);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.goal.id).toBe(goalId);
        expect(resolved.goal.title).toBe("explicit target");
      }
    } finally {
      db.close();
    }
  });

  it("refuses a missing explicit id with goal_not_found and the dataDir in the message", () => {
    const dataDir = makeTempDir();
    seedGoal(dataDir, "present goal");
    const db = openDb(dataDir);
    try {
      const resolved = resolveGoalForReadBack(db, dataDir, "missing-goal");
      expect(resolved).toEqual({
        ok: false,
        code: "goal_not_found",
        error: `Goal missing-goal was not found in ${dataDir}.`
      });
    } finally {
      db.close();
    }
  });

  it("refuses with no_goals when no id is given and the store is empty", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const resolved = resolveGoalForReadBack(db, dataDir, undefined);
      expect(resolved).toEqual({
        ok: false,
        code: "no_goals",
        error: `No goals found in ${dataDir}.`
      });
    } finally {
      db.close();
    }
  });

  it("defaults to the latest goal by created_at when no id is given", () => {
    const dataDir = makeTempDir();
    const older = seedGoal(dataDir, "older goal");
    const newer = seedGoal(dataDir, "newer goal");
    const db = openDb(dataDir);
    try {
      setGoalCreatedAt(db, older, 1_000);
      setGoalCreatedAt(db, newer, 2_000);

      expect(findLatestGoal(db)?.id).toBe(newer);

      const resolved = resolveGoalForReadBack(db, dataDir, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) expect(resolved.goal.id).toBe(newer);
    } finally {
      db.close();
    }
  });
});
