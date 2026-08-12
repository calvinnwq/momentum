import { describe, expect, it } from "vitest";
import {
  normalizeAgentResult,
  normalizeLegacyRunnerResult,
  parseAgentResult,
} from "../src/core/executors/agent-result/result.js";
import {
  AGENT_RESULT_SCHEMA,
  LEGACY_RUNNER_RESULT_SCHEMA,
} from "../src/core/executors/agent-result/types.js";
import type { AgentResult } from "../src/core/executors/agent-result/types.js";

const VALID: AgentResult = {
  success: true,
  summary: "Applied fake agent fixture.",
  key_changes_made: ["Created or modified fixture target file."],
  key_learnings: [],
  remaining_work: [],
  objective_complete: false,
  commit: {
    type: "test",
    scope: "milestone-1",
    subject: "prove foreground momentum iteration",
    body: "",
    breaking: false,
  },
};

const { objective_complete: _objectiveComplete, ...VALID_WITHOUT_COMPLETION } =
  VALID;

const LEGACY = {
  ...VALID_WITHOUT_COMPLETION,
  goal_complete: false,
};

describe("normalizeAgentResult", () => {
  it("returns the result unchanged when fully valid", () => {
    const result = normalizeAgentResult(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(VALID);
      expect(result.schema).toBe(AGENT_RESULT_SCHEMA);
    }
  });

  it("trims summary and array entries", () => {
    const result = normalizeAgentResult({
      ...VALID,
      summary: "  Applied fake agent fixture.  ",
      key_changes_made: ["  Created or modified fixture target file.  "],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toBe("Applied fake agent fixture.");
      expect(result.value.key_changes_made).toEqual([
        "Created or modified fixture target file.",
      ]);
    }
  });

  it("defaults missing optional arrays to empty arrays", () => {
    const partial = {
      success: true,
      summary: "ok",
      key_changes_made: ["c"],
      objective_complete: false,
      commit: VALID.commit,
    };
    const result = normalizeAgentResult(partial);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.key_learnings).toEqual([]);
      expect(result.value.remaining_work).toEqual([]);
    }
  });

  it("rejects non-object input", () => {
    const result = normalizeAgentResult("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/object/i);
    }
  });

  it("rejects when success is not a boolean", () => {
    const result = normalizeAgentResult({ ...VALID, success: "true" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/success/);
    }
  });

  it("rejects when summary is missing or empty", () => {
    const missing = normalizeAgentResult({ ...VALID, summary: undefined });
    expect(missing.ok).toBe(false);
    const empty = normalizeAgentResult({ ...VALID, summary: "   " });
    expect(empty.ok).toBe(false);
  });

  it("rejects when objective_complete is not a boolean", () => {
    const result = normalizeAgentResult({
      ...VALID,
      objective_complete: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/objective_complete/);
    }
  });

  it("rejects legacy goal_complete documents on the current-schema path", () => {
    const result = normalizeAgentResult(LEGACY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/goal_complete/);
      expect(result.error).toMatch(/objective_complete/);
    }
  });

  it("fails closed when both completion fields are present", () => {
    const result = normalizeAgentResult({ ...VALID, goal_complete: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ambiguous/i);
    }
  });

  it("rejects when key_changes_made entries are not strings", () => {
    const result = normalizeAgentResult({
      ...VALID,
      key_changes_made: ["fine", 5],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/key_changes_made/);
    }
  });

  it("rejects when commit is missing", () => {
    const { commit: _commit, ...rest } = VALID;
    const result = normalizeAgentResult(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit/);
    }
  });

  it("rejects unknown commit type", () => {
    const result = normalizeAgentResult({
      ...VALID,
      commit: { ...VALID.commit, type: "feature" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit\.type/);
    }
  });

  it("rejects empty commit subject", () => {
    const result = normalizeAgentResult({
      ...VALID,
      commit: { ...VALID.commit, subject: "  " },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit\.subject/);
    }
  });

  it("trims commit subject and strips trailing period", () => {
    const result = normalizeAgentResult({
      ...VALID,
      commit: {
        ...VALID.commit,
        subject: "  prove foreground momentum iteration.  ",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.subject).toBe(
        "prove foreground momentum iteration",
      );
    }
  });

  it("defaults commit body to empty string and breaking to false", () => {
    const result = normalizeAgentResult({
      ...VALID,
      commit: {
        type: "test",
        scope: "milestone-1",
        subject: "prove foreground momentum iteration",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.body).toBe("");
      expect(result.value.commit.breaking).toBe(false);
    }
  });

  it("normalizes scope to undefined when blank", () => {
    const result = normalizeAgentResult({
      ...VALID,
      commit: { ...VALID.commit, scope: "  " },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.commit.scope).toBeUndefined();
    }
  });

  it("rejects non-boolean commit.breaking", () => {
    const result = normalizeAgentResult({
      ...VALID,
      commit: { ...VALID.commit, breaking: "true" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/commit\.breaking/);
    }
  });
});

describe("normalizeLegacyRunnerResult", () => {
  it("reads historical goal_complete documents into the same internal shape", () => {
    const result = normalizeLegacyRunnerResult({
      ...LEGACY,
      goal_complete: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schema).toBe(LEGACY_RUNNER_RESULT_SCHEMA);
      expect(result.value).toEqual({ ...VALID, objective_complete: true });
    }
  });

  it("normalizes legacy and current documents identically", () => {
    const legacy = normalizeLegacyRunnerResult(LEGACY);
    const current = normalizeAgentResult(VALID);
    expect(legacy.ok).toBe(true);
    expect(current.ok).toBe(true);
    if (legacy.ok && current.ok) {
      expect(legacy.value).toEqual(current.value);
    }
  });

  it("rejects documents without goal_complete", () => {
    const result = normalizeLegacyRunnerResult(VALID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/goal_complete/);
    }
  });

  it("fails closed when both completion fields are present", () => {
    const result = normalizeLegacyRunnerResult({
      ...LEGACY,
      objective_complete: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ambiguous/i);
    }
  });

  it("rejects when goal_complete is not a boolean", () => {
    const result = normalizeLegacyRunnerResult({
      ...LEGACY,
      goal_complete: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/goal_complete/);
    }
  });
});

describe("parseAgentResult", () => {
  it("parses well-formed current-schema JSON and validates", () => {
    const result = parseAgentResult(JSON.stringify(VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schema).toBe(AGENT_RESULT_SCHEMA);
      expect(result.value.commit.subject).toBe(
        "prove foreground momentum iteration",
      );
    }
  });

  it("routes historical goal_complete documents to the legacy reader", () => {
    const result = parseAgentResult(JSON.stringify(LEGACY));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schema).toBe(LEGACY_RUNNER_RESULT_SCHEMA);
      expect(result.value.objective_complete).toBe(false);
    }
  });

  it("fails closed on documents carrying both completion fields", () => {
    const mixed = { ...VALID, goal_complete: false };
    const result = parseAgentResult(JSON.stringify(mixed));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ambiguous/i);
      expect(result.error).toMatch(/goal_complete/);
      expect(result.error).toMatch(/objective_complete/);
    }
  });

  it("fails closed on mixed documents even when the values agree", () => {
    const mixed = {
      ...VALID,
      objective_complete: true,
      goal_complete: true,
    };
    const result = parseAgentResult(JSON.stringify(mixed));
    expect(result.ok).toBe(false);
  });

  it("rejects documents with neither completion field", () => {
    const result = parseAgentResult(JSON.stringify(VALID_WITHOUT_COMPLETION));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/objective_complete/);
    }
  });

  it("reports JSON parse errors clearly", () => {
    const result = parseAgentResult("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/json/i);
    }
  });
});
