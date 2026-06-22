import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS,
  EXTERNAL_UPDATE_MUTATION_KINDS,
  listExternalUpdateAdapterKinds
} from "../src/adapters/external-update-adapter.js";
import { DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT } from "../src/adapters/linear-external-update-client.js";
import { SOURCE_RECONCILIATION_RUN_STATES } from "../src/core/source/reconciliation-runs.js";
import { expectSpecSection, readRepoFile } from "./helpers/repo-docs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return readRepoFile(relative);
}

describe("adapter test coverage contract", () => {
  const spec = readDoc("SPEC.md");

  it("keeps compact adapter boundary anchors in SPEC.md", () => {
    expectSpecSection(spec, "Source And Adapter Boundaries");
    expect(spec).toContain("Default CI must not call real `api.linear.app`");
  });

  it("pins external adapter and mutation vocabularies in code", () => {
    expect([...BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS]).toEqual(["linear"]);
    expect(listExternalUpdateAdapterKinds()).toEqual(["linear"]);
    expect([...EXTERNAL_UPDATE_MUTATION_KINDS]).toEqual(["comment", "status_transition"]);
    expect(DEFAULT_LINEAR_EXTERNAL_UPDATE_ENDPOINT).toBe("https://api.linear.app/graphql");
  });

  it("keeps source reconciliation states explicit", () => {
    expect([...SOURCE_RECONCILIATION_RUN_STATES]).toEqual([
      "running",
      "succeeded",
      "failed",
    ]);
  });

  it("continues to prove adapter composition with executable tests", () => {
    for (const rel of [
      "test/source-adapter.test.ts",
      "test/linear-source-adapter.test.ts",
      "test/source-reconciliation.test.ts",
      "test/external-update-adapter.test.ts",
      "test/intent-apply-execute.test.ts",
      "test/runner-adapter.test.ts",
      "test/workflow-step-executor.test.ts",
      "test/workflow-dispatch-execute.test.ts",
      "test/full-adapter-e2e.test.ts",
    ]) {
      expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} should exist`).toBe(true);
    }
  });
});
