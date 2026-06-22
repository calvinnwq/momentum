import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M9 live workflow execution contract", () => {
  const spec = readDoc("SPEC.md");

  it("preserves M9 provenance and live-wrapper safety terms", () => {
    expect(spec).toContain("M9: NGX-331 through NGX-338");
    expect(spec).toMatch(/normalized result evidence/i);
    expect(spec).toMatch(/manual_recovery_required/i);
  });

  it("keeps live-wrapper operator profile documented", () => {
    const daemonDocs = readDoc("docs/daemon.md");
    expect(daemonDocs).toContain("MOMENTUM_LIVE_WRAPPER_PROFILE");
    expect(daemonDocs).toContain("MOMENTUM_RESULT_PATH");
  });
});
