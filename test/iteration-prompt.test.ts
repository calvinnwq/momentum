import { describe, expect, it } from "vitest";
import { renderIterationPrompt, type IterationPromptContext } from "../src/iteration-prompt.js";
import type { GoalSpec } from "../src/goal-spec.js";

const FAKE_HEAD = "0123456789abcdef0123456789abcdef01234567";

const SPEC: GoalSpec = {
  title: "Prove foreground iteration",
  repo: "/tmp/disposable-repo",
  runner: "fake",
  branch: "momentum/prove-foreground-iteration",
  max_iterations: 1,
  verification: ["pnpm test", "pnpm typecheck"],
  verification_timeout_sec: 900,
  body: "Apply the fixture and write a runner result.\n\nNo commits."
};

const CTX: IterationPromptContext = {
  spec: SPEC,
  goalId: "8e3a0c7a-1111-2222-3333-444455556666",
  iteration: 1,
  repoPath: "/tmp/disposable-repo",
  baseHead: FAKE_HEAD
};

describe("renderIterationPrompt", () => {
  it("includes goal id, title, branch, iteration, and runner", () => {
    const out = renderIterationPrompt(CTX);
    expect(out).toContain(`goal_id: ${CTX.goalId}`);
    expect(out).toContain(`title: ${SPEC.title}`);
    expect(out).toContain(`iteration: 1 of ${SPEC.max_iterations}`);
    expect(out).toContain(`branch: ${SPEC.branch}`);
    expect(out).toContain(`runner: ${SPEC.runner}`);
  });

  it("includes the repo path and pre-iteration HEAD", () => {
    const out = renderIterationPrompt(CTX);
    expect(out).toContain(`path: ${CTX.repoPath}`);
    expect(out).toContain(`pre_iteration_head: ${FAKE_HEAD}`);
  });

  it("renders the goal body verbatim including blank lines", () => {
    const out = renderIterationPrompt(CTX);
    expect(out).toContain("Apply the fixture and write a runner result.\n\nNo commits.");
  });

  it("falls back to placeholder text when goal body is empty", () => {
    const out = renderIterationPrompt({
      ...CTX,
      spec: { ...SPEC, body: "   \n  " }
    });
    expect(out).toContain("(no goal body provided)");
  });

  it("lists verification commands as bullets and emits the timeout", () => {
    const out = renderIterationPrompt(CTX);
    expect(out).toContain("- pnpm test");
    expect(out).toContain("- pnpm typecheck");
    expect(out).toContain("- timeout_sec: 900");
  });

  it("emits a placeholder when no verification commands are configured", () => {
    const out = renderIterationPrompt({
      ...CTX,
      spec: { ...SPEC, verification: [] }
    });
    expect(out).toContain("(none configured)");
  });

  it("includes the runner result JSON contract with every required field", () => {
    const out = renderIterationPrompt(CTX);
    for (const field of [
      '"success": boolean',
      '"summary": string',
      '"key_changes_made": string[]',
      '"key_learnings": string[]',
      '"remaining_work": string[]',
      '"goal_complete": boolean',
      '"commit"',
      '"type":',
      '"scope": string',
      '"subject": string',
      '"body": string',
      '"breaking": boolean'
    ]) {
      expect(out).toContain(field);
    }
  });

  it("instructs the runner not to create commits or push", () => {
    const out = renderIterationPrompt(CTX);
    expect(out).toContain("Do not create git commits");
    expect(out).toContain("Do not push or fetch");
    expect(out).toContain("Stage no changes");
  });

  it("ends with a single trailing newline", () => {
    const out = renderIterationPrompt(CTX);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("rejects iteration values that are not positive integers", () => {
    expect(() => renderIterationPrompt({ ...CTX, iteration: 0 })).toThrow(
      /positive integer/
    );
    expect(() => renderIterationPrompt({ ...CTX, iteration: 1.5 })).toThrow(
      /positive integer/
    );
  });

  it("rejects iteration values above max_iterations", () => {
    expect(() => renderIterationPrompt({ ...CTX, iteration: 2 })).toThrow(
      /exceeds max_iterations/
    );
  });

  it("rejects baseHead values that are not 40-char hex SHAs", () => {
    expect(() => renderIterationPrompt({ ...CTX, baseHead: "abc123" })).toThrow(
      /40-char git SHA/
    );
    expect(() =>
      renderIterationPrompt({ ...CTX, baseHead: "Z".repeat(40) })
    ).toThrow(/40-char git SHA/);
  });

  it("includes MOMENTUM.md policy notes as context when provided", () => {
    const out = renderIterationPrompt({
      ...CTX,
      policyNotes: "Prefer focused tests over snapshot churn.",
      policyPath: "/tmp/disposable-repo/MOMENTUM.md"
    });
    expect(out).toContain("## Policy notes (from MOMENTUM.md)");
    expect(out).toContain("/tmp/disposable-repo/MOMENTUM.md");
    expect(out).toContain("Prefer focused tests over snapshot churn.");
    expect(out).toContain(
      "Policy notes are context, not executable overrides."
    );
  });

  it("omits the policy notes section when policyNotes is empty or whitespace", () => {
    expect(renderIterationPrompt({ ...CTX, policyNotes: "" })).not.toContain(
      "Policy notes (from MOMENTUM.md)"
    );
    expect(
      renderIterationPrompt({ ...CTX, policyNotes: "   \n\t" })
    ).not.toContain("Policy notes (from MOMENTUM.md)");
  });

  it("orders policy notes before the Rules section", () => {
    const out = renderIterationPrompt({
      ...CTX,
      policyNotes: "REPO_POLICY_NOTE_SENTINEL"
    });
    const policyIdx = out.indexOf("REPO_POLICY_NOTE_SENTINEL");
    const rulesIdx = out.indexOf("## Rules");
    expect(policyIdx).toBeGreaterThan(0);
    expect(rulesIdx).toBeGreaterThan(policyIdx);
  });
});
