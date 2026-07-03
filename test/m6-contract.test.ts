import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_INTENT_APPLY_POLICY,
  UPDATE_INTENT_APPLY_POLICIES,
  isExternalApplyAllowedByPolicy
} from "../src/core/intent/policy.js";
import {
  INTENT_APPLY_LIFECYCLE_STATES,
  INTENT_APPLY_STATES
} from "../src/core/intent/apply-audits.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M6 external-apply contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the compact M6 provenance anchor", () => {
    expect(spec).toContain("M6: NGX-295 through NGX-302");
  });

  it("pins external-apply policy and audit state vocabularies in code", () => {
    expect(DEFAULT_INTENT_APPLY_POLICY).toBe("create_intents_only");
    expect([...UPDATE_INTENT_APPLY_POLICIES]).toEqual([
      "create_intents_only",
      "external_apply_allowed",
    ]);
    expect(
      isExternalApplyAllowedByPolicy({
        runner: undefined,
        verification: undefined,
        verificationTimeoutSec: undefined,
        intentApplyPolicy: "create_intents_only",
      })
    ).toBe(false);
    expect(
      isExternalApplyAllowedByPolicy({
        runner: undefined,
        verification: undefined,
        verificationTimeoutSec: undefined,
        intentApplyPolicy: "external_apply_allowed",
      })
    ).toBe(true);
    expect([...INTENT_APPLY_STATES]).toEqual(["idle", "in_flight", "blocked"]);
    expect([...INTENT_APPLY_LIFECYCLE_STATES]).toEqual([
      "claimed",
      "succeeded",
      "failed",
      "blocked",
      "audit_incomplete",
    ]);
  });

  it("keeps external-apply documented as an operator-facing command", () => {
    const intentDocs = readDoc("docs/intent-commands.md");
    expect(intentDocs).toContain("--external-apply");
    expect(intentDocs).toContain("applyPolicy");
    expect(intentDocs).toContain("externalApply");
  });

  it("keeps internal M6 planning detail out of public docs", () => {
    expect(readDoc("README.md")).not.toContain("Milestone 6");
    expect(readDoc("README.md")).not.toContain("NGX-295");
    expect(readDoc("docs/index.html")).not.toMatch(/m6-external-apply/i);
  });
});
