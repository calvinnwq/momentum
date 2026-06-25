import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  LIVE_STEP_WRAPPER_RECOVERY_CODES
} from "../src/adapters/live-step-wrapper.js";
import {
  WORKFLOW_LEASE_FRESHNESS_CLASSIFICATIONS,
  WORKFLOW_LEASE_STALE_POLICIES
} from "../src/core/workflow/run-reducer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M9 live workflow execution contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the compact M9 provenance anchor", () => {
    expect(spec).toContain("M9: NGX-331 through NGX-338");
  });

  it("pins live-wrapper recovery and lease safety vocabularies in code", () => {
    expect([...LIVE_STEP_WRAPPER_RECOVERY_CODES]).toEqual([
      "runtime_unavailable",
      "auth_unavailable",
      "command_failed",
      "command_timed_out",
      "output_overflow",
      "result_missing",
      "result_invalid",
    ]);
    expect(LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect([...WORKFLOW_LEASE_STALE_POLICIES]).toEqual([
      "auto-release",
      "manual-recovery-required",
    ]);
    expect([...WORKFLOW_LEASE_FRESHNESS_CLASSIFICATIONS]).toEqual([
      "released",
      "fresh",
      "stale-auto-release",
      "stale-manual-recovery-required",
    ]);
  });

  it("keeps live-wrapper operator profile documented", () => {
    const daemonDocs = readDoc("docs/daemon.md");
    expect(daemonDocs).toContain("MOMENTUM_LIVE_WRAPPER_PROFILE");
    expect(daemonDocs).toContain("MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG");
    expect(daemonDocs).toContain("MOMENTUM_RESULT_PATH");
    expect(daemonDocs).toMatch(/operator\s+setup failure/);
  });
});
