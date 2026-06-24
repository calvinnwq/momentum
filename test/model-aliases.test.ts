import { describe, expect, it } from "vitest";

import {
  CODEX_MODEL_ALIASES,
  MODEL_ALIASES_BY_HARNESS,
  OPENAI_MODEL_IDS,
  OPENCODE_MODEL_ALIASES,
  resolveCommandModelAlias
} from "../src/core/model-aliases.js";

describe("model-aliases — shared command model registry", () => {
  it("exports reusable alias constants instead of hiding route mappings inline", () => {
    expect([...MODEL_ALIASES_BY_HARNESS.keys()]).toEqual([
      "claude",
      "codex",
      "opencode"
    ]);
    expect(CODEX_MODEL_ALIASES).toContainEqual([
      "openai/gpt-5.5",
      "gpt-5.5"
    ]);
    expect(OPENCODE_MODEL_ALIASES).toContainEqual([
      "gpt-5.5",
      "openai/gpt-5.5"
    ]);
  });

  it("keeps shared OpenAI ids aligned across Codex and OpenCode alias surfaces", () => {
    for (const modelId of OPENAI_MODEL_IDS) {
      expect(resolveCommandModelAlias("codex", `openai/${modelId}`)).toBe(
        modelId
      );
      expect(resolveCommandModelAlias("opencode", modelId)).toBe(
        `openai/${modelId}`
      );
    }
  });

  it("normalizes only known provider aliases and leaves future values free-form", () => {
    expect(resolveCommandModelAlias("claude", "sonnet")).toBe(
      "claude-sonnet-4-6"
    );
    expect(resolveCommandModelAlias("codex", "spark")).toBe(
      "gpt-5.3-codex-spark"
    );
    expect(resolveCommandModelAlias("opencode", "glm-5.2")).toBe(
      "opencode-go/glm-5.2"
    );
    expect(resolveCommandModelAlias("gh-cli", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveCommandModelAlias("codex", "future-model")).toBe(
      "future-model"
    );
  });
});
