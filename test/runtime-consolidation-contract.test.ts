import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("runtime consolidation plan contract", () => {
  const contractPath = "internal/contracts/runtime-consolidation-plan.md";

  it("exists, owns NGX-434, and authorizes no deletion by itself", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/Runtime Consolidation Plan/i);
    expect(contract).toContain("NGX-434");
    expect(contract).toMatch(/authorizes \*\*no\*\* production code\s+deletion/i);
    expect(contract).toMatch(/This planning issue deletes no production code/i);
  });

  it("uses an explicit keep / deprecate-later / defer decision vocabulary", () => {
    const contract = readDoc(contractPath);

    for (const term of ["**Keep**", "**Deprecate-later**", "**Defer**"]) {
      expect(contract, `decision vocabulary should define ${term}`).toContain(term);
    }
    // No path may be classified "remove now".
    expect(contract).toMatch(/No path in this plan is classified "remove now"/i);
  });

  it("classifies each of the six audited runtime paths with a prerequisite", () => {
    const contract = readDoc(contractPath);

    for (const path of [
      "Goal-first CLI compatibility",
      ".agent-workflows",
      "cwfp-*",
      "executor-loop finalization",
      "phase-1 scaffold",
      "external-apply",
      "subworkflow",
      "Fake workflow-step executors",
    ]) {
      expect(contract, `plan should name the ${path} path`).toContain(path);
    }

    // Every path section names a prerequisite gate before narrowing.
    expect(contract).toMatch(/Prerequisite before any narrowing/i);
    expect(contract).toMatch(/Prerequisite before narrowing/i);
    expect(contract).toMatch(/Prerequisite before removal of the fail-closed branch/i);
  });

  it("decides the M9 / M10 step-finalization boundary and names the open gap", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/M9 \/ M10 step-finalization boundary/i);
    // M9 owns the direct workflow_steps lifecycle; M10 adapters own nested evidence only.
    expect(contract).toContain("finishWorkflowStep");
    expect(contract).toContain("executor_invocations");
    expect(contract).toContain("executor_rounds");
    expect(contract).toContain("merge-cleanup` to the dispatchable `script`");
    expect(contract).toContain("linear-refresh` to the non-dispatchable, fail-closed");
    expect(contract).toMatch(/execution lane/i);
    // The open gap: only the dogfood stand-in finalizes a dispatched step today.
    expect(contract).toContain("workflow-dogfood-dispatch.ts");
    expect(contract).toMatch(/exactly one/i);
    expect(contract).toMatch(/reconciliation seam/i);
    // The phase-1 scaffold must carry no fabricated evidence.
    expect(contract).toMatch(/no fabricated (result )?evidence/i);
  });

  it("keeps the cwfp default-route narrowing on the existing NGX-404 track", () => {
    const contract = readDoc(contractPath);

    expect(contract).toContain("NGX-404");
    expect(contract).toMatch(/import\/read path (stays|survives)/i);
    expect(contract).toContain("coding-workflow-ownership.md");
  });

  it("lists a follow-up RC-* sequence with RC-2 leading", () => {
    const contract = readDoc(contractPath);

    for (const id of ["RC-1", "RC-2", "RC-3", "RC-4", "RC-5"]) {
      expect(contract, `follow-up sequence should list ${id}`).toContain(id);
    }
    // Follow-ups are listed, not created from runtime code.
    expect(contract).toMatch(/listed, not created/i);
    expect(contract).toMatch(/RC-2 is the prerequisite for the most consolidation/i);
  });

  it("records the RC-2 reconciliation seam as landed (NGX-480) and names the next item", () => {
    const contract = readDoc(contractPath);

    // RC-2's production reconciliation seam has landed under NGX-480, naming the
    // pure decider + effect twin that own the single finalization path.
    expect(contract).toContain("NGX-480");
    expect(contract).toMatch(/Landed \(NGX-480\)/);
    expect(contract).toContain("reconcileDispatchedWorkflowStep");
    expect(contract).toContain("dispatch-reconcile-execute.ts");

    // The dogfood stand-in is retained as an explicit test/dogfood-only fixture,
    // with no production terminal gap hidden behind it.
    expect(contract).toMatch(/test\/dogfood-only/);

    // With RC-2 landed, the plan names the next remaining runtime consolidation item.
    expect(contract).toMatch(/next remaining runtime\s+consolidation/i);
  });

  it("is linked from the runtime/test audit baseline", () => {
    const audit = readDoc("internal/runtime-test-audit.md");
    expect(audit, "audit should link the consolidation plan").toContain(
      "contracts/runtime-consolidation-plan.md"
    );
  });
});
