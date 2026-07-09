import { describe, expect, it } from "vitest";
import {
  BUILTIN_RUNNER_KINDS,
  DEFAULT_RUNNER_KIND,
  buildRunnerProfile,
  isBuiltinRunnerKind,
  parseRunnerProfile,
  resolveRunnerProfile,
  safeRunnerProfileSummary
} from "../src/core/executors/runner/profile.js";

describe("runner-profile registry", () => {
  it("exposes a stable set of supported built-in kinds including fake, trusted-shell, and acp", () => {
    expect(BUILTIN_RUNNER_KINDS).toEqual(["fake", "trusted-shell", "acp"]);
    expect(DEFAULT_RUNNER_KIND).toBe("fake");
  });

  it("recognizes supported runner names via isBuiltinRunnerKind", () => {
    expect(isBuiltinRunnerKind("fake")).toBe(true);
    expect(isBuiltinRunnerKind("trusted-shell")).toBe(true);
    expect(isBuiltinRunnerKind("acp")).toBe(true);
    expect(isBuiltinRunnerKind("codex")).toBe(false);
    expect(isBuiltinRunnerKind("")).toBe(false);
  });

  it("builds the fake compatibility profile with a safe summary", () => {
    const profile = buildRunnerProfile("fake");
    expect(profile).toEqual({
      kind: "fake",
      name: "fake",
      description:
        "Built-in compatibility fake runner profile retained for stored goal-first data and diagnostics; the retired lane wrote a fixture file and reported a normalized result.",
      executes: true
    });
  });

  it("builds the trusted-shell compatibility profile with the explicit-trust caveat", () => {
    const profile = buildRunnerProfile("trusted-shell");
    expect(profile.kind).toBe("trusted-shell");
    expect(profile.executes).toBe(true);
    expect(profile.description).toContain("no sandbox");
    expect(profile.description).toContain("no privilege drop");
  });

  it("builds the acp compatibility profile with a runtime_unavailable caveat", () => {
    const profile = buildRunnerProfile("acp");
    expect(profile.kind).toBe("acp");
    expect(profile.executes).toBe(true);
    expect(profile.description).toContain("ACP");
    expect(profile.description).toContain("runtime_unavailable");
  });
});

describe("parseRunnerProfile", () => {
  it("parses a normalized fake profile from a plain string", () => {
    const result = parseRunnerProfile("fake");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("fake");
    expect(result.profile.executes).toBe(true);
  });

  it("accepts a syntactically valid trusted-shell identity as executing", () => {
    const result = parseRunnerProfile("trusted-shell");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("trusted-shell");
    expect(result.profile.executes).toBe(true);
  });

  it("accepts a syntactically valid acp identity as executing after M4-04", () => {
    const result = parseRunnerProfile("acp");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("acp");
    expect(result.profile.executes).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    const result = parseRunnerProfile("  fake  ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("fake");
  });

  it("returns unsupported_runner for unknown runner names", () => {
    const result = parseRunnerProfile("codex");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_runner");
    expect(result.error).toMatch(/Unsupported runner profile "codex"/);
    expect(result.error).toContain("fake");
    expect(result.error).toContain("trusted-shell");
    expect(result.error).toContain("acp");
  });

  it("returns malformed_profile for empty strings", () => {
    const result = parseRunnerProfile("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_profile");
  });

  it("returns malformed_profile for non-string inputs", () => {
    const result = parseRunnerProfile(42 as unknown);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_profile");
    expect(result.error).toMatch(/number/);
  });
});

describe("resolveRunnerProfile precedence", () => {
  it("falls back to the built-in fake default when nothing is provided", () => {
    const result = resolveRunnerProfile({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("fake");
    expect(result.source).toBe("builtin_default");
    expect(result.rawValue).toBe("fake");
  });

  it("uses goal frontmatter when CLI override is absent", () => {
    const result = resolveRunnerProfile({ frontmatterValue: "trusted-shell" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("trusted-shell");
    expect(result.source).toBe("goal_frontmatter");
    expect(result.rawValue).toBe("trusted-shell");
  });

  it("lets CLI --runner override beat the goal frontmatter value", () => {
    const result = resolveRunnerProfile({
      cliOverride: "trusted-shell",
      frontmatterValue: "fake"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("trusted-shell");
    expect(result.source).toBe("cli_override");
    expect(result.rawValue).toBe("trusted-shell");
  });

  it("treats blank CLI override as absent and uses the next layer", () => {
    const result = resolveRunnerProfile({
      cliOverride: "   ",
      frontmatterValue: "trusted-shell"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("trusted-shell");
    expect(result.source).toBe("goal_frontmatter");
  });

  it("surfaces unsupported_runner with the source that supplied the bad value", () => {
    const result = resolveRunnerProfile({ cliOverride: "codex" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_runner");
    expect(result.source).toBe("cli_override");
    expect(result.rawValue).toBe("codex");
  });

  it("surfaces malformed_profile from non-string goal frontmatter", () => {
    const result = resolveRunnerProfile({ frontmatterValue: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_profile");
    expect(result.source).toBe("goal_frontmatter");
    expect(result.rawValue).toBe("42");
  });

  it("surfaces malformed_profile from blank goal frontmatter", () => {
    const result = resolveRunnerProfile({ frontmatterValue: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_profile");
    expect(result.source).toBe("goal_frontmatter");
    expect(result.rawValue).toBe("");
  });

  it("surfaces unsupported_runner from goal frontmatter when CLI override is absent", () => {
    const result = resolveRunnerProfile({ frontmatterValue: "claude" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_runner");
    expect(result.source).toBe("goal_frontmatter");
    expect(result.rawValue).toBe("claude");
  });

  it("uses MOMENTUM.md policy when goal frontmatter is absent", () => {
    const result = resolveRunnerProfile({ policyValue: "trusted-shell" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("trusted-shell");
    expect(result.source).toBe("momentum_policy");
    expect(result.rawValue).toBe("trusted-shell");
  });

  it("lets goal frontmatter beat MOMENTUM.md policy", () => {
    const result = resolveRunnerProfile({
      frontmatterValue: "fake",
      policyValue: "trusted-shell"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("fake");
    expect(result.source).toBe("goal_frontmatter");
  });

  it("lets CLI --runner beat both goal frontmatter and MOMENTUM.md policy", () => {
    const result = resolveRunnerProfile({
      cliOverride: "acp",
      frontmatterValue: "fake",
      policyValue: "trusted-shell"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("acp");
    expect(result.source).toBe("cli_override");
  });

  it("treats blank MOMENTUM.md policy value as absent and falls back to the built-in default", () => {
    const result = resolveRunnerProfile({ policyValue: "   " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.kind).toBe("fake");
    expect(result.source).toBe("builtin_default");
  });
});

describe("safeRunnerProfileSummary", () => {
  it("returns identity + safe summary for embedding in status/handoff JSON", () => {
    const summary = safeRunnerProfileSummary(buildRunnerProfile("fake"));
    expect(summary).toEqual({
      kind: "fake",
      name: "fake",
      description:
        "Built-in compatibility fake runner profile retained for stored goal-first data and diagnostics; the retired lane wrote a fixture file and reported a normalized result.",
      executes: true
    });
  });
});
