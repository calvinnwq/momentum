import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("runtime consolidation contract", () => {
  const spec = readDoc("SPEC.md");

  it("uses explicit keep / deprecate-later / defer vocabulary", () => {
    for (const term of ["**Keep**", "**Deprecate-later**", "**Defer**"]) {
      expect(spec, `SPEC.md should define ${term}`).toContain(term);
    }

    expect(spec).toMatch(/No consolidation plan authorizes production deletion by itself/i);
  });

  it("records the landed RC sequence and RC-2 finalization owner", () => {
    for (const id of ["RC-1", "RC-1b", "RC-1c", "RC-2", "RC-3", "RC-4", "RC-4b", "RC-5", "RC-5b"]) {
      expect(spec, `SPEC.md should list ${id}`).toContain(id);
    }

    expect(spec).toMatch(/RC-2[\s\S]*single production owner/i);
    expect(spec).toMatch(/double-finalize and double-write/i);
  });

  it("keeps runtime-consolidation guidance out of the public docs front door", () => {
    expect(readDoc("README.md")).not.toMatch(/runtime-consolidation|RC-2|RC-4b/);
    expect(readDoc("docs/index.md")).not.toMatch(/runtime-consolidation|RC-2|RC-4b/);
  });
});
