import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RECOVERY_ARTIFACT_FILENAME,
  buildRecoveryMarkdown,
  resolveRecoveryArtifactPath,
  writeRecoveryArtifact,
  type RecoveryArtifactInput
} from "../src/recovery-artifact.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-recovery-artifact-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeFullInput(overrides: Partial<RecoveryArtifactInput> = {}): RecoveryArtifactInput {
  return {
    goalId: "goal-abc",
    goalTitle: "Demo goal",
    iteration: 3,
    jobId: "job-xyz",
    daemonRunId: "daemon-1",
    repoPath: "/tmp/some-repo",
    expectedCommit: "aaaaaaa",
    currentCommit: "bbbbbbb",
    reason: {
      code: "repo_dirty",
      message: "Uncommitted changes detected during stale claim recovery."
    },
    artifactPaths: {
      iterationDir: "/tmp/data/goals/goal-abc/iterations/3",
      runnerLog: "/tmp/data/goals/goal-abc/iterations/3/runner.log",
      verificationLog:
        "/tmp/data/goals/goal-abc/iterations/3/verification.log",
      resultJson: "/tmp/data/goals/goal-abc/iterations/3/result.json"
    },
    safeNextSteps: [
      "Inspect repo with `git status`.",
      "Resolve dirty state and run `momentum recovery clear <goal-id>`."
    ],
    classifiedAt: 1717000000000,
    schemaVersion: 1,
    ...overrides
  };
}

describe("recovery-artifact", () => {
  it("renders all required fields with stable section headings", () => {
    const md = buildRecoveryMarkdown(makeFullInput());
    expect(md).toMatch(/^# Manual recovery required: Demo goal\n/);
    expect(md).toContain("- Schema version: 1");
    expect(md).toContain("- Goal ID: goal-abc");
    expect(md).toContain("- Job ID: job-xyz");
    expect(md).toContain("- Iteration: 3");
    expect(md).toContain("- Daemon run ID: daemon-1");
    expect(md).toContain("- Repo path: /tmp/some-repo");
    expect(md).toContain("- Classified at (epoch ms): 1717000000000");
    expect(md).toContain("## Reason");
    expect(md).toContain("- Code: repo_dirty");
    expect(md).toContain(
      "- Message: Uncommitted changes detected during stale claim recovery."
    );
    expect(md).toContain("## Commit pointers");
    expect(md).toContain("- Expected (pre-iteration) commit: aaaaaaa");
    expect(md).toContain("- Current commit: bbbbbbb");
    expect(md).toContain("## Relevant artifacts");
    expect(md).toContain(
      "- Iteration dir: /tmp/data/goals/goal-abc/iterations/3"
    );
    expect(md).toContain(
      "- Runner log: /tmp/data/goals/goal-abc/iterations/3/runner.log"
    );
    expect(md).toContain(
      "- Verification log: /tmp/data/goals/goal-abc/iterations/3/verification.log"
    );
    expect(md).toContain(
      "- Result JSON: /tmp/data/goals/goal-abc/iterations/3/result.json"
    );
    expect(md).toContain("## Safe next steps");
    expect(md).toContain("1. Inspect repo with `git status`.");
    expect(md).toContain(
      "2. Resolve dirty state and run `momentum recovery clear <goal-id>`."
    );
    expect(md.endsWith("\n")).toBe(true);
  });

  it("renders placeholders for unknown optional fields", () => {
    const md = buildRecoveryMarkdown(
      makeFullInput({
        daemonRunId: null,
        expectedCommit: null,
        currentCommit: null,
        artifactPaths: {
          iterationDir: "/tmp/iter",
          runnerLog: null,
          verificationLog: null,
          resultJson: null
        }
      })
    );
    expect(md).toContain("- Daemon run ID: (none)");
    expect(md).toContain("- Expected (pre-iteration) commit: (unknown)");
    expect(md).toContain("- Current commit: (unknown)");
    expect(md).toContain("- Runner log: (none)");
    expect(md).toContain("- Verification log: (none)");
    expect(md).toContain("- Result JSON: (none)");
  });

  it("renders a fallback when no safe next steps are provided", () => {
    const md = buildRecoveryMarkdown(makeFullInput({ safeNextSteps: [] }));
    expect(md).toContain("## Safe next steps");
    expect(md).toContain(
      "- No automatic next steps suggested. Inspect the artifacts above and decide manually."
    );
  });

  it("requires a non-empty goal ID", () => {
    expect(() =>
      buildRecoveryMarkdown(makeFullInput({ goalId: "" }))
    ).toThrow(/goalId/);
  });

  it("requires a positive integer iteration", () => {
    expect(() =>
      buildRecoveryMarkdown(makeFullInput({ iteration: 0 }))
    ).toThrow(/iteration/);
    expect(() =>
      buildRecoveryMarkdown(makeFullInput({ iteration: 1.5 }))
    ).toThrow(/iteration/);
  });

  it("requires a non-empty reason code and message", () => {
    expect(() =>
      buildRecoveryMarkdown(
        makeFullInput({ reason: { code: "", message: "x" } })
      )
    ).toThrow(/reason\.code/);
    expect(() =>
      buildRecoveryMarkdown(
        makeFullInput({ reason: { code: "x", message: "" } })
      )
    ).toThrow(/reason\.message/);
  });

  it("resolveRecoveryArtifactPath returns the goal-scoped recovery.md", () => {
    const dataDir = "/var/momentum";
    const resolved = resolveRecoveryArtifactPath(dataDir, "goal-abc");
    expect(resolved).toBe(
      path.join(dataDir, "goals", "goal-abc", RECOVERY_ARTIFACT_FILENAME)
    );
    expect(RECOVERY_ARTIFACT_FILENAME).toBe("recovery.md");
  });

  it("writeRecoveryArtifact writes recovery.md with the rendered body", () => {
    const dataDir = makeTempDir();
    const goalDir = path.join(dataDir, "goals", "goal-abc");
    fs.mkdirSync(goalDir, { recursive: true });
    const input = makeFullInput();
    const result = writeRecoveryArtifact({
      dataDir,
      input
    });
    expect(result.path).toBe(
      path.join(goalDir, RECOVERY_ARTIFACT_FILENAME)
    );
    const written = fs.readFileSync(result.path, "utf-8");
    expect(written).toBe(buildRecoveryMarkdown(input));
    expect(written).toContain("# Manual recovery required: Demo goal");
  });

  it("writeRecoveryArtifact creates the goal directory when missing", () => {
    const dataDir = makeTempDir();
    const result = writeRecoveryArtifact({
      dataDir,
      input: makeFullInput({ goalId: "fresh-goal" })
    });
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path).toBe(
      path.join(dataDir, "goals", "fresh-goal", RECOVERY_ARTIFACT_FILENAME)
    );
  });

  it("writeRecoveryArtifact is overwrite-safe and preserves the rendered body", () => {
    const dataDir = makeTempDir();
    const input = makeFullInput();
    const first = writeRecoveryArtifact({ dataDir, input });
    fs.writeFileSync(first.path, "stale", "utf-8");
    const second = writeRecoveryArtifact({ dataDir, input });
    expect(second.path).toBe(first.path);
    expect(fs.readFileSync(second.path, "utf-8")).toBe(
      buildRecoveryMarkdown(input)
    );
  });
});
