import { describe, expect, it } from "vitest";
import {
  normalizeRunnerResult,
  parseRunnerResult
} from "../src/core/executors/runner-result.js";
import type { RunnerResult } from "../src/core/executors/types.js";

const VALID: RunnerResult = {
  success: true,
  summary: "Applied fake runner fixture.",
  key_changes_made: ["Created or modified fixture target file."],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-1",
    subject: "prove foreground momentum iteration",
    body: "",
    breaking: false
  }
};

describe("normalizeRunnerResult", () => {
  it("returns the result unchanged when fully valid", () => {
    const result = normalizeRunnerResult(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(VALID);
    }
  });

  it("trims summary and array entries", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      summary: "  Applied fake runner fixture.  ",
      key_changes_made: ["  Created or modified fixture target file.  "]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toBe("Applied fake runner fixture.");
      expect(result.value.key_changes_made).toEqual([
        "Created or modified fixture target file."
      ]);
    }
  });

  it("defaults missing optional arrays to empty arrays", () => {
    const partial = {
      success: true,
      summary: "ok",
      key_changes_made: ["c"],
      goal_complete: false,
      commit: VALID.commit
    };
    const result = normalizeRunnerResult(partial);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.key_learnings).toEqual([]);
      expect(result.value.remaining_work).toEqual([]);
    }
  });

  it("rejects non-object input", () => {
    const result = normalizeRunnerResult("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/object/i);
    }
  });

  it("rejects when success is not a boolean", () => {
    const result = normalizeRunnerResult({ ...VALID, success: "true" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/success/);
    }
  });

  it("rejects when summary is missing or empty", () => {
    const missing = normalizeRunnerResult({ ...VALID, summary: undefined });
    expect(missing.ok).toBe(false);
    const empty = normalizeRunnerResult({ ...VALID, summary: "   " });
    expect(empty.ok).toBe(false);
  });

  it("rejects when goal_complete is not a boolean", () => {
    const result = normalizeRunnerResult({ ...VALID, goal_complete: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/goal_complete/);
    }
  });

  it("rejects when key_changes_made entries are not strings", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      key_changes_made: ["fine", 5]
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/key_changes_made/);
    }
  });

  it("rejects when commit is missing", () => {
    const { commit: _commit, ...rest } = VALID;
    const result = normalizeRunnerResult(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit/);
    }
  });

  it("rejects unknown commit type", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      commit: { ...VALID.commit, type: "feature" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit\.type/);
    }
  });

  it("rejects empty commit subject", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      commit: { ...VALID.commit, subject: "  " }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit\.subject/);
    }
  });

  it("trims commit subject and strips trailing period", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      commit: {
        ...VALID.commit,
        subject: "  prove foreground momentum iteration.  "
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.subject).toBe(
        "prove foreground momentum iteration"
      );
    }
  });

  it("defaults commit body to empty string and breaking to false", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      commit: {
        type: "test",
        scope: "milestone-1",
        subject: "prove foreground momentum iteration"
      }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.body).toBe("");
      expect(result.value.commit.breaking).toBe(false);
    }
  });

  it("normalizes scope to undefined when blank", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      commit: { ...VALID.commit, scope: "  " }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.scope).toBeUndefined();
    }
  });

  it("rejects non-boolean commit.breaking", () => {
    const result = normalizeRunnerResult({
      ...VALID,
      commit: { ...VALID.commit, breaking: "true" }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit\.breaking/);
    }
  });
});

describe("parseRunnerResult", () => {
  it("parses well-formed JSON and validates", () => {
    const result = parseRunnerResult(JSON.stringify(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.subject).toBe(
        "prove foreground momentum iteration"
      );
    }
  });

  it("reports JSON parse errors clearly", () => {
    const result = parseRunnerResult("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/json/i);
    }
  });
});
