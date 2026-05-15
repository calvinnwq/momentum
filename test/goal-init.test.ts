import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initGoal } from "../src/goal-init.js";

const VALID_SPEC = `---
title: Test Goal
repo: /tmp/test-repo
runner: fake
verification:
  - pnpm test
---

Goal body content.
`;

const INVALID_SPEC = `---
runner: fake
---
No title here.
`;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "momentum-init-"));
}

describe("initGoal integration", () => {
  it("initializes SQLite and artifact layout from a valid goal spec", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const result = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Goal ID is a UUID
    expect(result.goalId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/
    );

    // Spec values
    expect(result.spec.title).toBe("Test Goal");
    expect(result.spec.verification).toEqual(["pnpm test"]);

    // Artifact files exist
    const { artifactPaths } = result;
    expect(fs.existsSync(artifactPaths.goalMd)).toBe(true);
    expect(fs.existsSync(artifactPaths.ledgerMd)).toBe(true);
    expect(fs.existsSync(artifactPaths.handoffMd)).toBe(true);
    expect(fs.existsSync(artifactPaths.handoffJson)).toBe(true);
    expect(fs.existsSync(artifactPaths.promptMd)).toBe(true);
    expect(fs.existsSync(artifactPaths.runnerLog)).toBe(true);
    expect(fs.existsSync(artifactPaths.verificationLog)).toBe(true);
    expect(fs.existsSync(artifactPaths.resultJson)).toBe(true);

    // goal.md contains the original spec
    expect(fs.readFileSync(artifactPaths.goalMd, "utf-8")).toBe(VALID_SPEC);

    // SQLite goal row exists
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(result.goalId) as Record<string, unknown>;
    const job = db.prepare("SELECT * FROM jobs WHERE goal_id = ?").get(result.goalId) as Record<string, unknown>;
    db.close();

    expect(row).toBeDefined();
    expect(row["title"]).toBe("Test Goal");
    expect(row["state"]).toBe("initialized");
    expect(row["runner"]).toBe("fake");
    expect(JSON.parse(row["verification"] as string)).toEqual(["pnpm test"]);
    expect(job).toBeDefined();
    expect(job["id"]).toBe(result.jobId);
    expect(job["type"]).toBe("foreground_iteration");
    expect(job["iteration"]).toBe(1);
    expect(job["state"]).toBe("pending");
    expect(job["artifact_path"]).toBe(artifactPaths.iterationDir);

    fs.rmSync(dataDir, { recursive: true });
  });

  it("creates goals, jobs, and events tables in SQLite", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    initGoal({ goalPath: goalFile, dataDirOptions: { dataDir } });

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    db.close();

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("goals");
    expect(tableNames).toContain("jobs");
    expect(tableNames).toContain("events");

    fs.rmSync(dataDir, { recursive: true });
  });

  it("returns error on parse failure without creating any artifacts", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "bad-goal.md");
    fs.writeFileSync(goalFile, INVALID_SPEC, "utf-8");

    const result = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/title/);

    // No goal artifact directory should be created
    const goalsDir = path.join(dataDir, "goals");
    expect(fs.existsSync(goalsDir)).toBe(false);

    // SQLite db should not exist (parse failed before openDb)
    expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);

    fs.rmSync(dataDir, { recursive: true });
  });

  it("returns error when goal file does not exist", () => {
    const result = initGoal({
      goalPath: "/does/not/exist/goal.md",
      dataDirOptions: { dataDir: makeTempDir() }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Cannot read/);
  });

  it("repo override takes precedence over frontmatter repo", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const result = initGoal({
      goalPath: goalFile,
      repoOverride: "/override/repo",
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.repo).toBe("/override/repo");

    fs.rmSync(dataDir, { recursive: true });
  });

  it("runner override takes precedence over frontmatter runner", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const result = initGoal({
      goalPath: goalFile,
      runnerOverride: "trusted-shell",
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.runner).toBe("trusted-shell");
    expect(result.runnerProfile.kind).toBe("trusted-shell");
    expect(result.runnerProfileSource).toBe("cli_override");

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    const row = db.prepare("SELECT runner FROM goals WHERE id = ?").get(result.goalId) as Record<string, unknown>;
    db.close();
    expect(row["runner"]).toBe("trusted-shell");

    fs.rmSync(dataDir, { recursive: true });
  });

  it("returns unsupported_runner when --runner is not a built-in profile", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const result = initGoal({
      goalPath: goalFile,
      runnerOverride: "claude-code",
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_runner");
    expect(result.error).toMatch(/claude-code/);

    fs.rmSync(dataDir, { recursive: true });
  });

  it("resolves data dir from MOMENTUM_HOME env var", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const altDataDir = makeTempDir();
    const result = initGoal({
      goalPath: goalFile,
      dataDirOptions: { env: { MOMENTUM_HOME: altDataDir } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataDir).toBe(altDataDir);
    expect(fs.existsSync(path.join(altDataDir, "momentum.db"))).toBe(true);

    fs.rmSync(dataDir, { recursive: true });
    fs.rmSync(altDataDir, { recursive: true });
  });

  it("resumes an initialized goal row instead of creating duplicates", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const first = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });
    const second = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    expect(second.goalId).toBe(first.goalId);
    expect(second.jobId).toBe(first.jobId);

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    const goalCount = db.prepare("SELECT count(*) AS count FROM goals").get() as { count: number };
    const jobCount = db.prepare("SELECT count(*) AS count FROM jobs").get() as { count: number };
    db.close();

    expect(goalCount.count).toBe(1);
    expect(jobCount.count).toBe(1);

    fs.rmSync(dataDir, { recursive: true });
  });

  it("does not resume an initialized goal when spec content changes", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const first = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });
    fs.writeFileSync(
      goalFile,
      VALID_SPEC.replace("Goal body content.", "Changed body content."),
      "utf-8"
    );
    const second = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.resumed).toBe(false);
    expect(second.goalId).not.toBe(first.goalId);

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    const goalCount = db.prepare("SELECT count(*) AS count FROM goals").get() as { count: number };
    db.close();
    expect(goalCount.count).toBe(2);

    fs.rmSync(dataDir, { recursive: true });
  });

  it("resumes a later initialized goal when an older artifact differs", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");

    const first = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });
    fs.writeFileSync(
      goalFile,
      VALID_SPEC.replace("Goal body content.", "Changed body content."),
      "utf-8"
    );
    const second = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });
    const third = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir }
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    expect(third.resumed).toBe(true);
    expect(third.goalId).toBe(second.goalId);
    expect(third.jobId).toBe(second.jobId);

    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    const goalCount = db.prepare("SELECT count(*) AS count FROM goals").get() as { count: number };
    db.close();
    expect(goalCount.count).toBe(2);

    fs.rmSync(dataDir, { recursive: true });
  });

  it("returns init error when data dir is not a directory", () => {
    const dataDir = makeTempDir();
    const goalFile = path.join(dataDir, "goal.md");
    const blockedDataDir = path.join(dataDir, "blocked");
    fs.writeFileSync(goalFile, VALID_SPEC, "utf-8");
    fs.writeFileSync(blockedDataDir, "not a directory", "utf-8");

    const result = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir: blockedDataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Failed to initialize goal/);

    fs.rmSync(dataDir, { recursive: true });
  });
});
