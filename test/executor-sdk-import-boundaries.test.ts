import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const adaptersRoot = path.join(repoRoot, "src", "adapters");

const ADAPTER_EXECUTOR_CORE_EDGE_DISPOSITIONS = new Map<string, string>([
  [
    "src/adapters/no-mistakes-executor.ts -> src/core/executors/delegate-supervisor/classifier.ts",
    "compatibility mirror delegates to the official supervision classifier",
  ],
  [
    "src/adapters/git-transaction.ts -> src/core/executors/runner/types.ts",
    "official SDK CommitIntent type surface",
  ],
  [
    "src/adapters/live-step-wrapper.ts -> src/core/executors/runner/result.ts",
    "official SDK RunnerResult parser surface",
  ],
  [
    "src/adapters/live-step-wrapper.ts -> src/core/executors/runner/types.ts",
    "official SDK RunnerResult type surface",
  ],
  [
    "src/adapters/no-mistakes-executor.ts -> src/core/executors/loop/persist.ts",
    "temporary until delegate-supervisor reduces this adapter to a tool adapter",
  ],
  [
    "src/adapters/no-mistakes-tool-adapter.ts -> src/core/executors/delegate-supervisor/types.ts",
    "official delegated-tool lifecycle adapter interface",
  ],
  [
    "src/adapters/no-mistakes-tool-adapter.ts -> src/core/executors/no-mistakes/mechanism.ts",
    "tool-owned external-state reader and normalizer",
  ],
  [
    "src/adapters/no-mistakes-executor.ts -> src/core/executors/loop/reducer.ts",
    "temporary until delegate-supervisor reduces this adapter to a tool adapter",
  ],
  [
    "src/adapters/no-mistakes-orchestrator.ts -> src/core/executors/loop/persist.ts",
    "temporary until delegate-supervisor reduces this adapter to a tool adapter",
  ],
  [
    "src/adapters/no-mistakes-orchestrator.ts -> src/core/executors/loop/reducer.ts",
    "temporary until delegate-supervisor reduces this adapter to a tool adapter",
  ],
  [
    "src/adapters/no-mistakes-orchestrator.ts -> src/core/executors/no-mistakes/mechanism.ts",
    "temporary until delegate-supervisor reduces this adapter to a tool adapter",
  ],
  [
    "src/adapters/real-workflow-probe.ts -> src/core/executors/smoke/workflow-harness.ts",
    "temporary gated smoke support pending a dedicated test-support boundary",
  ],
]);

const README_MARKER_BY_EDGE = new Map<string, string>([
  [
    "src/adapters/no-mistakes-executor.ts -> src/core/executors/delegate-supervisor/classifier.ts",
    "`no-mistakes-executor.ts` → `delegate-supervisor/classifier.ts`",
  ],
  [
    "src/adapters/git-transaction.ts -> src/core/executors/runner/types.ts",
    "`git-transaction.ts` → `runner/types.ts`",
  ],
  [
    "src/adapters/live-step-wrapper.ts -> src/core/executors/runner/result.ts",
    "`live-step-wrapper.ts` → `runner/result.ts` and `runner/types.ts`",
  ],
  [
    "src/adapters/live-step-wrapper.ts -> src/core/executors/runner/types.ts",
    "`live-step-wrapper.ts` → `runner/result.ts` and `runner/types.ts`",
  ],
  ...[
    "src/adapters/no-mistakes-executor.ts -> src/core/executors/loop/persist.ts",
    "src/adapters/no-mistakes-executor.ts -> src/core/executors/loop/reducer.ts",
    "src/adapters/no-mistakes-orchestrator.ts -> src/core/executors/loop/persist.ts",
    "src/adapters/no-mistakes-orchestrator.ts -> src/core/executors/loop/reducer.ts",
    "src/adapters/no-mistakes-orchestrator.ts -> src/core/executors/no-mistakes/mechanism.ts",
  ].map(
    (edge) =>
      [
        edge,
        "`no-mistakes-executor.ts` / `no-mistakes-orchestrator.ts` → `loop/*` and `no-mistakes/mechanism.ts`",
      ] as const,
  ),
  ...[
    "src/adapters/no-mistakes-tool-adapter.ts -> src/core/executors/delegate-supervisor/types.ts",
    "src/adapters/no-mistakes-tool-adapter.ts -> src/core/executors/no-mistakes/mechanism.ts",
  ].map(
    (edge) =>
      [
        edge,
        "`no-mistakes-tool-adapter.ts` → `delegate-supervisor/types.ts` and `no-mistakes/mechanism.ts`",
      ] as const,
  ),
  [
    "src/adapters/real-workflow-probe.ts -> src/core/executors/smoke/workflow-harness.ts",
    "`real-workflow-probe.ts` → `smoke/workflow-harness.ts`",
  ],
]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files.sort();
}

function executorCoreImportEdges(): string[] {
  const edges: string[] = [];
  for (const absolute of sourceFiles(adaptersRoot)) {
    const source = fs.readFileSync(absolute, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith(".")) continue;
      const target = path
        .relative(
          repoRoot,
          path.resolve(path.dirname(absolute), imported.fileName),
        )
        .replace(/\.js$/, ".ts");
      if (!target.startsWith("src/core/executors/")) continue;
      const from = path.relative(repoRoot, absolute);
      edges.push(`${from} -> ${target}`);
    }
  }
  return edges.sort();
}

describe("executor SDK adapter boundaries", () => {
  it("allows only official SDK imports or explicitly disposed temporary edges", () => {
    expect(
      executorCoreImportEdges(),
      "Every adapter-to-executor-core edge must be official SDK surface or carry an explicit temporary disposition in src/core/executors/README.md.",
    ).toEqual([...ADAPTER_EXECUTOR_CORE_EDGE_DISPOSITIONS.keys()].sort());

    for (const disposition of ADAPTER_EXECUTOR_CORE_EDGE_DISPOSITIONS.values()) {
      expect(disposition.length).toBeGreaterThan(30);
    }
  });

  it("keeps every temporary reverse edge documented with its exit boundary", () => {
    const readme = fs.readFileSync(
      path.join(repoRoot, "src/core/executors/README.md"),
      "utf8",
    );
    expect([...README_MARKER_BY_EDGE.keys()].sort()).toEqual(
      [...ADAPTER_EXECUTOR_CORE_EDGE_DISPOSITIONS.keys()].sort(),
    );
    for (const [edge, marker] of README_MARKER_BY_EDGE) {
      expect(
        readme,
        `${edge} must retain its exact README disposition row`,
      ).toContain(marker);
    }
  });

  it("keeps the public type contract free of persistence and database imports", () => {
    const contract = fs.readFileSync(
      path.join(repoRoot, "src/core/executors/sdk/types.ts"),
      "utf8",
    );
    expect(contract).not.toContain("adapters/db");
    expect(contract).not.toContain("loop/persist");
  });
});
