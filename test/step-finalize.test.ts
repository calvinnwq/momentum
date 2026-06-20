import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  finalizeWorkflowStep,
  finalizeWorkflowStepFromResultFile
} from "../src/core/executors/step-finalize.js";
import {
  finalizeLiveWorkflowStep,
  finalizeLiveWorkflowStepFromResultFile
} from "../src/core/executors/live-step-finalize.js";
import type { CommitIntent } from "../src/core/executors/types.js";

// Covers the NGX-494 shared finalization seam (`step-finalize.ts`), the
// workflow/runtime-owned home the verify -> commit / reset transaction moved to
// so the goal-loop executor family no longer depends on the M9-named
// `live-step-finalize.ts` module as an ownership boundary. The single-shot
// family still reaches the seam through the back-compat alias.
//
// The git-heavy outcomes (committed / reset / moved-HEAD manual recovery) stay
// exhaustively covered by `live-step-finalize.test.ts`, which now exercises the
// *moved* implementation through the back-compat alias surface. This file proves
// two things that pin the relocation without re-running real git:
//
//   1. The neutral seam's no-git decision paths (input validation and
//      result-document recovery routing) behave as the contract requires when
//      called directly under the new names.
//   2. The M9 alias surface re-exports the *same* function objects, so every
//      behavior the M9 integration tests prove about the `*LiveWorkflowStep*`
//      names holds verbatim for the neutral seam — the move is byte-equivalent.

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
    breaking: false
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
      verificationLogPath: "/tmp/verify.log"
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
      verificationLogPath: "/tmp/verify.log"
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
      verificationLogPath: "/tmp/verify.log"
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
      verificationLogPath: path.join(dir, "verify.log")
    });
    expect(result.outcome).toBe("result_missing");
    if (result.outcome === "result_missing") {
      // The durable "live step ..." contract wording is preserved verbatim
      // across the relocation.
      expect(result.error).toBe(
        `live step result file was not written at ${resultFilePath}.`
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
      verificationLogPath: path.join(dir, "verify.log")
    });
    expect(result.outcome).toBe("result_invalid");
    if (result.outcome === "result_invalid") {
      expect(result.error).toMatch(/^live step result JSON is invalid:/);
      expect(result.resultFilePath).toBe(resultFilePath);
    }
  });
});

describe("M9 live-step finalization back-compat alias surface", () => {
  it("re-exports the same finalize functions the neutral seam owns", () => {
    // Identity equivalence: the M9 `*LiveWorkflowStep*` names are the neutral
    // seam's functions, so the git-heavy behavior pinned by the M9 integration
    // tests applies to the relocated seam unchanged.
    expect(finalizeLiveWorkflowStep).toBe(finalizeWorkflowStep);
    expect(finalizeLiveWorkflowStepFromResultFile).toBe(
      finalizeWorkflowStepFromResultFile
    );
  });
});
