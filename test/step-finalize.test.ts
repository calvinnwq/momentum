import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  finalizeWorkflowStep,
  finalizeWorkflowStepFromResultFile,
} from "../src/core/executors/shared/step-finalize.js";
import type { CommitIntent } from "../src/core/executors/runner/types.js";

// Covers the NGX-494 shared finalization seam (`step-finalize.ts`), the
// workflow/runtime-owned home of the verify -> commit / reset transaction that
// the agent-loop and single-shot executors consume directly. The
// M9-named `live-step/finalize.ts` back-compat alias was deleted with the M9
// live-step lane under NGX-599, so the neutral seam is the only surface.
//
// The git-heavy outcomes (committed / reset / moved-HEAD manual recovery) stay
// exhaustively covered by `live-step-finalize.test.ts` against the same neutral
// seam. This file pins the seam's no-git decision paths (input validation and
// result-document recovery routing) plus the ownership boundary below.

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-step-finalize-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const VALID_SHA = "a".repeat(40);

function baseIntent(): CommitIntent {
  return {
    type: "chore",
    scope: "step",
    subject: "finalize step",
    body: "",
    breaking: false,
  };
}

describe("finalizeWorkflowStep (shared seam, no-git decision paths)", () => {
  it("rejects an invalid baseHead before touching git", () => {
    const result = finalizeWorkflowStep({
      repoPath: "/does/not/matter",
      baseHead: "not-a-sha",
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 5,
      verificationLogPath: "/tmp/verify.log",
    });
    expect(result.outcome).toBe("invalid_input");
    if (result.outcome === "invalid_input") {
      expect(result.error).toMatch(/baseHead/);
    }
  });

  it("rejects a missing repoPath before touching git", () => {
    const result = finalizeWorkflowStep({
      repoPath: "   ",
      baseHead: VALID_SHA,
      stepSuccess: true,
      commitIntent: baseIntent(),
      verificationCommands: [],
      verificationTimeoutSec: 5,
      verificationLogPath: "/tmp/verify.log",
    });
    expect(result.outcome).toBe("invalid_input");
    if (result.outcome === "invalid_input") {
      expect(result.error).toMatch(/repoPath/);
    }
  });
});

describe("finalizeWorkflowStepFromResultFile (shared seam, no-git decision paths)", () => {
  it("returns invalid_input when resultFilePath is blank", () => {
    const result = finalizeWorkflowStepFromResultFile({
      repoPath: "/does/not/matter",
      baseHead: VALID_SHA,
      resultFilePath: "   ",
      verificationCommands: [],
      verificationTimeoutSec: 5,
      verificationLogPath: "/tmp/verify.log",
    });
    expect(result.outcome).toBe("invalid_input");
  });

  it("returns result_missing without mutating git when the document is absent", () => {
    const dir = makeTempDir();
    const resultFilePath = path.join(dir, "missing-result.json");
    const result = finalizeWorkflowStepFromResultFile({
      repoPath: "/does/not/matter",
      baseHead: VALID_SHA,
      resultFilePath,
      verificationCommands: [],
      verificationTimeoutSec: 5,
      verificationLogPath: path.join(dir, "verify.log"),
    });
    expect(result.outcome).toBe("result_missing");
    if (result.outcome === "result_missing") {
      // The durable "live step ..." contract wording is preserved verbatim
      // across the relocation.
      expect(result.error).toBe(
        `live step result file was not written at ${resultFilePath}.`,
      );
      expect(result.resultFilePath).toBe(resultFilePath);
    }
  });

  it("returns result_invalid without mutating git when the document is unparseable", () => {
    const dir = makeTempDir();
    const resultFilePath = path.join(dir, "bad-result.json");
    fs.writeFileSync(resultFilePath, "this is not a runner result", "utf-8");
    const result = finalizeWorkflowStepFromResultFile({
      repoPath: "/does/not/matter",
      baseHead: VALID_SHA,
      resultFilePath,
      verificationCommands: [],
      verificationTimeoutSec: 5,
      verificationLogPath: path.join(dir, "verify.log"),
    });
    expect(result.outcome).toBe("result_invalid");
    if (result.outcome === "result_invalid") {
      expect(result.error).toMatch(/^live step result JSON is invalid:/);
      expect(result.resultFilePath).toBe(resultFilePath);
    }
  });
});

describe("executor finalization ownership boundary (NGX-494 AC #1, NGX-599)", () => {
  // NGX-494 AC #1 disentangled the agent-loop family from the M9-named
  // finalization alias; NGX-599 deleted the M9 live-step lane and migrated the
  // single-shot executor too. Every executor must reach the shared
  // verify -> commit / reset transaction through the neutral
  // `shared/step-finalize.ts` seam; the deleted `live-step/finalize.ts` alias
  // path must never come back.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const seamConsumers = [
    "src/core/executors/agent-loop/mechanism.ts",
    "src/core/executors/agent-loop/executor.ts",
    "src/core/executors/agent-loop/orchestrator.ts",
    "src/core/executors/single-shot/mechanism.ts",
  ];

  for (const relative of seamConsumers) {
    it(`${relative} imports the finalization seam from shared/step-finalize.ts, not the M9 alias`, () => {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      expect(
        source.includes('"../shared/step-finalize.js"'),
        `${relative} should import the finalization seam from "../shared/step-finalize.js"`,
      ).toBe(true);
      expect(
        source.includes('"../live-step/finalize.js"'),
        `${relative} must not import from the M9 "../live-step/finalize.js" alias as an ownership boundary`,
      ).toBe(false);
    });
  }
});
