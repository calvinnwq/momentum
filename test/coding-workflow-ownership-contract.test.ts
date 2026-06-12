import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("Momentum-owned coding workflow contract", () => {
  const contractPath = "internal/contracts/coding-workflow-ownership.md";

  it("pins Momentum as the source of truth for the future coding workflow runtime", () => {
    const contract = readDoc(contractPath);

    for (const term of [
      "WorkflowDefinition",
      "WorkflowRun",
      "StepRun",
      "gates",
      "leases",
      "executor state",
      "evidence",
      "recovery",
    ]) {
      expect(contract, `contract should name ${term}`).toContain(term);
    }

    expect(contract).toMatch(/Momentum owns the durable runtime/i);
    expect(contract).toMatch(/OpenClaw must not remain\s+the source of truth/i);
  });

  it("keeps OpenClaw as client and compatibility layer, not orchestrator owner", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/OpenClaw: user-facing skill, Discord delivery, rendering, compatibility/i);
    expect(contract).toMatch(/must not:\s*\n\n- Treat a `cwfp-\*` plan as the primary state/i);
    expect(contract).toMatch(/should not synthesize a\s+parallel plan \/ ledger \/ monitor as the primary state store/i);
  });

  it("preserves CWFP as the stable production path until dogfood proves the replacement", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/The stable production route remains/i);
    expect(contract).toContain("approve pipeline cwfp-... through merge cleanup");
    expect(contract).toMatch(/default remains CWFP/i);
    expect(contract).toMatch(/historical `cwfp-\*` runs remain readable/i);
  });

  it("requires Momentum-native starts to be opt-in and distinct from cwfp ids", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/future opt-in Momentum-native route should start in Momentum first/i);
    expect(contract).toContain("momentum workflow run start --definition coding-workflow");
    expect(contract).toMatch(/run ids must be distinct from `cwfp-\*` run ids/i);
  });

  it("keeps no-mistakes adapter work separate from later native decomposition", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/`NGX-402` is the near-term adapter \/ mirror/i);
    expect(contract).toMatch(/`NGX-392` through `NGX-395` are the later replacement \/ decomposition path/i);
    expect(contract).toMatch(/not permanently dependent on no-mistakes/i);
  });

  it("is linked from roadmap, exclusions, and the workflow-first runtime contract", () => {
    for (const rel of [
      "internal/roadmap.md",
      "internal/exclusions.md",
      "internal/contracts/workflow-first-runtime.md",
    ]) {
      expect(readDoc(rel), `${rel} should link the ownership contract`).toContain(contractPath);
    }
  });
});
