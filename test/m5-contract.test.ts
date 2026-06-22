import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LINEAR_SOURCE_ADAPTER_KIND } from "../src/adapters/linear-source-adapter.js";
import {
  BUILTIN_SOURCE_ADAPTER_KINDS,
  type SourceAdapterErrorCode
} from "../src/adapters/source-adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

describe("M5 provenance anchor", () => {
  const spec = readDoc("SPEC.md");

  it("preserves the compact M5 provenance anchor", () => {
    expect(spec).toContain("M5: NGX-287 through NGX-294");
  });

  it("pins source adapter identity and error vocabulary in code", () => {
    expect(LINEAR_SOURCE_ADAPTER_KIND).toBe("linear");
    expect([...BUILTIN_SOURCE_ADAPTER_KINDS]).toEqual(["local-fixture", "linear"]);
    const errorCodes: SourceAdapterErrorCode[] = [
      "unsupported_source_adapter",
      "source_adapter_threw",
      "source_item_not_found",
      "source_item_invalid",
      "source_auth_unavailable",
      "source_config_invalid",
    ];
    expect(errorCodes).toContain("source_auth_unavailable");
  });

  it("keeps source adapter planning detail out of public docs", () => {
    expect(readDoc("README.md")).not.toContain("Milestone 5");
    expect(readDoc("README.md")).not.toContain("NGX-287");
    expect(readDoc("docs/index.md")).not.toMatch(/source-adapters/i);
  });

  it("keeps current source commands documented for operators", () => {
    const docs = readDoc("docs/source-commands.md");
    expect(docs).toContain("source list");
    expect(docs).toContain("source reconcile");
  });
});
