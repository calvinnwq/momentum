import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUILTIN_DEFAULT_VERIFICATION,
  BUILTIN_DEFAULT_VERIFICATION_TIMEOUT_SEC,
  MOMENTUM_POLICY_FILENAME,
  loadMomentumPolicy,
  parseMomentumPolicy,
  resolvePolicyEffectiveValues,
  resolvePolicyPath
} from "../src/momentum-policy.js";

function makeTempRepo(label = "momentum-policy-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

describe("resolvePolicyPath", () => {
  it("returns the repo-root MOMENTUM.md path for a valid repo", () => {
    const repo = makeTempRepo();
    const result = resolvePolicyPath(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(path.join(path.resolve(repo), MOMENTUM_POLICY_FILENAME));
  });

  it("rejects an empty repoPath with policy_path_invalid", () => {
    const result = resolvePolicyPath("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_path_invalid");
  });

  it("normalizes parent traversal in repoPath rather than escaping it", () => {
    // The loader only allows discovery at the resolved repo root; if a caller
    // passes a relative `..`, path.resolve normalizes it to an absolute path
    // that is itself the repo root the loader will use. This test guards the
    // invariant that the *MOMENTUM.md filename component* is never `..` or
    // absolute relative to the resolved repo.
    const repo = makeTempRepo();
    const nestedChild = path.join(repo, "child");
    fs.mkdirSync(nestedChild);
    const sneaky = path.join(nestedChild, "..");
    const result = resolvePolicyPath(sneaky);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedRepo = path.resolve(sneaky);
    expect(result.path).toBe(
      path.join(expectedRepo, MOMENTUM_POLICY_FILENAME)
    );
  });
});

describe("loadMomentumPolicy", () => {
  it("returns present:false when MOMENTUM.md is absent (no error)", () => {
    const repo = makeTempRepo();
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(false);
    expect(result.path).toBe(
      path.join(path.resolve(repo), MOMENTUM_POLICY_FILENAME)
    );
  });

  it("loads a valid MOMENTUM.md with frontmatter and notes", () => {
    const repo = makeTempRepo();
    const policyBody = `---
runner: trusted-shell
verification:
  - pnpm test
  - pnpm typecheck
verification_timeout_sec: 1800
---

Repo policy notes:
- Prefer focused tests over snapshot churn.
`;
    fs.writeFileSync(
      path.join(repo, MOMENTUM_POLICY_FILENAME),
      policyBody,
      "utf-8"
    );
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(true);
    if (!result.present) return;
    expect(result.policy.config.runner).toBe("trusted-shell");
    expect(result.policy.config.verification).toEqual([
      "pnpm test",
      "pnpm typecheck"
    ]);
    expect(result.policy.config.verificationTimeoutSec).toBe(1800);
    expect(result.policy.notes).toContain("Repo policy notes:");
    expect(result.policy.notes).toContain("Prefer focused tests");
  });

  it("treats a body-only MOMENTUM.md (no frontmatter) as policy notes with empty config", () => {
    const repo = makeTempRepo();
    fs.writeFileSync(
      path.join(repo, MOMENTUM_POLICY_FILENAME),
      "Free-form repo policy.\n\nKeep tests deterministic.\n",
      "utf-8"
    );
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.present) return;
    expect(result.policy.config.runner).toBeUndefined();
    expect(result.policy.config.verification).toBeUndefined();
    expect(result.policy.config.verificationTimeoutSec).toBeUndefined();
    expect(result.policy.notes).toContain("Free-form repo policy.");
    expect(result.policy.notes).toContain("Keep tests deterministic.");
  });

  it("surfaces policy_schema_invalid when runner is not a string", () => {
    const repo = makeTempRepo();
    const body = `---
runner: 42
---
`;
    fs.writeFileSync(path.join(repo, MOMENTUM_POLICY_FILENAME), body, "utf-8");
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_schema_invalid");
    expect(result.error).toMatch(/runner/);
  });

  it("surfaces policy_schema_invalid when verification is not an array", () => {
    const repo = makeTempRepo();
    const body = `---
verification: pnpm test
---
`;
    fs.writeFileSync(path.join(repo, MOMENTUM_POLICY_FILENAME), body, "utf-8");
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_schema_invalid");
    expect(result.error).toMatch(/verification/);
  });

  it("surfaces policy_schema_invalid when a verification entry is empty", () => {
    const repo = makeTempRepo();
    const body = `---
verification:
  - pnpm test
  - ""
---
`;
    fs.writeFileSync(path.join(repo, MOMENTUM_POLICY_FILENAME), body, "utf-8");
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_schema_invalid");
  });

  it("surfaces policy_schema_invalid when verification_timeout_sec is not a positive integer", () => {
    const repo = makeTempRepo();
    const body = `---
verification_timeout_sec: -1
---
`;
    fs.writeFileSync(path.join(repo, MOMENTUM_POLICY_FILENAME), body, "utf-8");
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_schema_invalid");
    expect(result.error).toMatch(/verification_timeout_sec/);
  });

  it("surfaces policy_parse_invalid when frontmatter has an indented top-level key", () => {
    const repo = makeTempRepo();
    const body = `---
  runner: fake
---
`;
    fs.writeFileSync(path.join(repo, MOMENTUM_POLICY_FILENAME), body, "utf-8");
    const result = loadMomentumPolicy(repo);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("policy_parse_invalid");
  });

  it("does NOT walk up to a parent repo's MOMENTUM.md", () => {
    const parentRepo = makeTempRepo("momentum-policy-parent-");
    fs.writeFileSync(
      path.join(parentRepo, MOMENTUM_POLICY_FILENAME),
      `---\nrunner: fake\n---\nparent policy notes\n`,
      "utf-8"
    );
    const childRepo = path.join(parentRepo, "child");
    fs.mkdirSync(childRepo);

    const result = loadMomentumPolicy(childRepo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Child has no MOMENTUM.md and the loader must not find the parent's.
    expect(result.present).toBe(false);
  });
});

describe("parseMomentumPolicy", () => {
  it("ignores comment lines in frontmatter", () => {
    const result = parseMomentumPolicy(
      `---\n# this is a comment\nrunner: fake\n---\nbody\n`
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.config.runner).toBe("fake");
    expect(result.policy.notes).toBe("body");
  });

  it("supports inline-array verification syntax", () => {
    const result = parseMomentumPolicy(
      `---\nverification: ["pnpm test", "pnpm typecheck"]\n---\n`
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.config.verification).toEqual([
      "pnpm test",
      "pnpm typecheck"
    ]);
  });
});

describe("resolvePolicyEffectiveValues", () => {
  it("uses goal frontmatter when explicitly provided, regardless of policy", () => {
    const eff = resolvePolicyEffectiveValues({
      goalVerificationProvided: true,
      goalVerification: ["goal cmd"],
      goalVerificationTimeoutSecProvided: true,
      goalVerificationTimeoutSec: 60,
      policyConfig: {
        runner: undefined,
        verification: ["policy cmd"],
        verificationTimeoutSec: 999
      }
    });
    expect(eff.verification).toEqual(["goal cmd"]);
    expect(eff.verificationTimeoutSec).toBe(60);
    expect(eff.source.verification).toBe("goal_frontmatter");
    expect(eff.source.verificationTimeoutSec).toBe("goal_frontmatter");
  });

  it("falls back to policy when goal frontmatter omits the field", () => {
    const eff = resolvePolicyEffectiveValues({
      goalVerificationProvided: false,
      goalVerification: [],
      goalVerificationTimeoutSecProvided: false,
      goalVerificationTimeoutSec: 900,
      policyConfig: {
        runner: undefined,
        verification: ["policy cmd"],
        verificationTimeoutSec: 1200
      }
    });
    expect(eff.verification).toEqual(["policy cmd"]);
    expect(eff.verificationTimeoutSec).toBe(1200);
    expect(eff.source.verification).toBe("momentum_policy");
    expect(eff.source.verificationTimeoutSec).toBe("momentum_policy");
  });

  it("falls back to built-in defaults when neither goal nor policy provide values", () => {
    const eff = resolvePolicyEffectiveValues({
      goalVerificationProvided: false,
      goalVerification: [],
      goalVerificationTimeoutSecProvided: false,
      goalVerificationTimeoutSec: BUILTIN_DEFAULT_VERIFICATION_TIMEOUT_SEC,
      policyConfig: undefined
    });
    expect(eff.verification).toEqual(BUILTIN_DEFAULT_VERIFICATION);
    expect(eff.verificationTimeoutSec).toBe(
      BUILTIN_DEFAULT_VERIFICATION_TIMEOUT_SEC
    );
    expect(eff.source.verification).toBe("builtin_default");
    expect(eff.source.verificationTimeoutSec).toBe("builtin_default");
  });
});
