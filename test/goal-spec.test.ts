import { describe, expect, it } from "vitest";
import { parseGoalSpec, parseGoalSpecFile } from "../src/goal-spec.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const FULL_SPEC = `---
title: Example Goal
repo: /absolute/repo/path
runner: fake
branch: momentum/example-goal
max_iterations: 3
verification:
  - pnpm test
  - pnpm build
verification_timeout_sec: 600
---

This is the goal body.
`;

const MINIMAL_SPEC = `---
title: My Minimal Goal
---

Body here.
`;

describe("parseGoalSpec", () => {
  it("parses all frontmatter fields from a full spec", () => {
    const result = parseGoalSpec(FULL_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec.title).toBe("Example Goal");
    expect(result.spec.repo).toBe("/absolute/repo/path");
    expect(result.spec.runner).toBe("fake");
    expect(result.spec.branch).toBe("momentum/example-goal");
    expect(result.spec.max_iterations).toBe(3);
    expect(result.spec.verification).toEqual(["pnpm test", "pnpm build"]);
    expect(result.spec.verification_timeout_sec).toBe(600);
    expect(result.spec.body).toContain("This is the goal body.");
  });

  it("applies defaults for optional fields when absent", () => {
    const result = parseGoalSpec(MINIMAL_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec.title).toBe("My Minimal Goal");
    expect(result.spec.repo).toBeUndefined();
    expect(result.spec.runner).toBe("fake");
    expect(result.spec.branch).toBe("momentum/my-minimal-goal");
    expect(result.spec.max_iterations).toBe(1);
    expect(result.spec.verification).toEqual([]);
    expect(result.spec.verification_timeout_sec).toBe(900);
  });

  it("repoOverride takes precedence over frontmatter repo", () => {
    const result = parseGoalSpec(FULL_SPEC, "/override/path");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.repo).toBe("/override/path");
  });

  it("runnerOverride takes precedence over frontmatter runner", () => {
    const result = parseGoalSpec(FULL_SPEC, undefined, "custom-runner");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.runner).toBe("custom-runner");
  });

  it("parses quoted verification list items as commands", () => {
    const result = parseGoalSpec(`---
title: Quoted Verification
verification:
  - "pnpm test"
  - 'pnpm build'
---
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.verification).toEqual(["pnpm test", "pnpm build"]);
  });

  it("parses inline verification arrays as commands", () => {
    const result = parseGoalSpec(`---
title: Inline Verification
verification: ["pnpm test", 'pnpm build']
---
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.verification).toEqual(["pnpm test", "pnpm build"]);
  });

  it("parses inline verification arrays with comments", () => {
    const result = parseGoalSpec(`---
title: Commented Inline Verification
verification: ["pnpm test"] # required check
---
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.verification).toEqual(["pnpm test"]);
  });

  it("parses verification block lists with comments on the key", () => {
    const result = parseGoalSpec(`---
title: Commented Verification Block
verification: # required checks
  - pnpm test
---
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.verification).toEqual(["pnpm test"]);
  });

  it("parses verification block lists after blank lines and comments", () => {
    const result = parseGoalSpec(`---
title: Spaced Verification Block
verification:

  # required checks
  - pnpm test
  - pnpm build
---
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.verification).toEqual(["pnpm test", "pnpm build"]);
  });

  it("repoOverride can supply repo when frontmatter has none", () => {
    const result = parseGoalSpec(MINIMAL_SPEC, "/from/flag");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.repo).toBe("/from/flag");
  });

  it("returns error when title is missing", () => {
    const noTitle = `---
repo: /some/path
---
Body
`;
    const result = parseGoalSpec(noTitle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/title/);
  });

  it("returns error when frontmatter is absent", () => {
    const result = parseGoalSpec("No frontmatter here.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/frontmatter/);
  });

  it("slugifies title with spaces and special chars for branch default", () => {
    const spec = `---\ntitle: Hello World! 2025\n---\n`;
    const result = parseGoalSpec(spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.branch).toBe("momentum/hello-world-2025");
  });

  it("returns error when title cannot derive a default branch", () => {
    const result = parseGoalSpec(`---
title: !!!
---
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/branch/);
  });

  it("returns error when max_iterations is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "three"]) {
      const result = parseGoalSpec(`---
title: Invalid Iterations
max_iterations: ${value}
---
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/max_iterations/);
    }
  });

  it("parses numeric frontmatter values with inline comments", () => {
    const result = parseGoalSpec(`---
title: Commented Numbers
max_iterations: 3 # retry budget
verification_timeout_sec: 120 # seconds
---
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.max_iterations).toBe(3);
    expect(result.spec.verification_timeout_sec).toBe(120);
  });

  it("returns error when verification_timeout_sec is not a positive integer", () => {
    for (const value of ["0", "-1", "1.5", "soon"]) {
      const result = parseGoalSpec(`---
title: Invalid Timeout
verification_timeout_sec: ${value}
---
`);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/verification_timeout_sec/);
    }
  });
});

describe("parseGoalSpecFile", () => {
  it("reads and parses a valid goal file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-spec-"));
    const filePath = path.join(tmp, "goal.md");
    fs.writeFileSync(filePath, FULL_SPEC, "utf-8");

    const result = parseGoalSpecFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe("Example Goal");

    fs.rmSync(tmp, { recursive: true });
  });

  it("returns error for a non-existent file", () => {
    const result = parseGoalSpecFile("/does/not/exist/goal.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Cannot read/);
  });

  it("repoOverride is forwarded to the parser", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-spec-"));
    const filePath = path.join(tmp, "goal.md");
    fs.writeFileSync(filePath, MINIMAL_SPEC, "utf-8");

    const result = parseGoalSpecFile(filePath, "/cli/repo", "cli-runner");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.repo).toBe("/cli/repo");
    expect(result.spec.runner).toBe("cli-runner");

    fs.rmSync(tmp, { recursive: true });
  });
});
