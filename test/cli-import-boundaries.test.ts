import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const srcRoot = path.join(repoRoot, "src");
const commandsDir = path.join("src", "commands");
const renderersDir = path.join("src", "renderers");
const adaptersDir = path.join("src", "adapters");
const coreDir = path.join("src", "core");
const configDir = path.join("src", "config");
const sharedDir = path.join("src", "shared");

const DURABLE_ROOT_SRC_ALLOWLIST = [
  "src/index.ts",
  "src/cli.ts",
  "src/suppress-sqlite-experimental-warning.ts",
  "src/node-shims.d.ts"
] as const;

type RootSrcException = {
  ownerIssue: "NGX-447" | "NGX-448" | "NGX-449" | "NGX-450";
  targetHome: `src/${string}.ts`;
  reason: string;
};

const TRANSITIONAL_ROOT_SRC_EXCEPTIONS = {
  "src/artifacts.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/evidence/artifacts.ts",
    reason: "Evidence artifact helpers remain flat until the evidence domain is grouped."
  },
  "src/branch-manager.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/repo/branch-manager.ts",
    reason: "Repo branch mutation primitives move with remaining repo-domain modules."
  },
  "src/daemon-loop.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/daemon/loop.ts",
    reason: "Daemon compatibility behavior remains flat until the daemon domain slice."
  },
  "src/daemon-runs.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/daemon/runs.ts",
    reason: "Daemon run persistence moves with daemon state ownership."
  },
  "src/daemon-status.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/daemon/status.ts",
    reason: "Daemon status state moves with daemon compatibility ownership."
  },
  "src/data-dir.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/config/data-dir.ts",
    reason: "Data-dir resolution is config support, not a root domain module."
  },
  "src/events.ts": {
    ownerIssue: "NGX-450",
    targetHome: "src/shared/events.ts",
    reason: "Cross-cutting event types need a shared/type-owned home."
  },
  "src/evidence-records.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/evidence/records.ts",
    reason: "Evidence record persistence moves with the evidence domain."
  },
  "src/evidence-workflow.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/evidence/workflow.ts",
    reason: "Workflow evidence linkage is owned by the evidence domain."
  },
  "src/executor-loop-persist.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/loop-persist.ts",
    reason: "Executor-loop persistence moves with executor core ownership."
  },
  "src/executor-loop-reducer.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/loop-reducer.ts",
    reason: "Executor-loop reducer behavior moves with executor core ownership."
  },
  "src/foreground-iteration.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/foreground-iteration.ts",
    reason: "Foreground iteration runtime behavior belongs with executor core modules."
  },
  "src/goal-init.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/init.ts",
    reason: "Goal-first compatibility initialization moves with the goal domain."
  },
  "src/goal-logs.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/logs.ts",
    reason: "Goal log behavior moves with goal compatibility state."
  },
  "src/goal-loop-executor.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/goal-loop-executor.ts",
    reason: "Goal-loop execution belongs with executor-family runtime behavior."
  },
  "src/goal-loop-mechanism.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/goal-loop-mechanism.ts",
    reason: "Goal-loop mechanism behavior belongs with executor-family runtime behavior."
  },
  "src/goal-loop-orchestrator.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/goal-loop-orchestrator.ts",
    reason: "Goal-loop orchestration belongs with executor-family runtime behavior."
  },
  "src/goal-recovery.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/recovery.ts",
    reason: "Goal recovery compatibility behavior moves with the goal domain."
  },
  "src/goal-reducer.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/reducer.ts",
    reason: "Goal state reducer behavior moves with goal compatibility state."
  },
  "src/goal-spec.ts": {
    ownerIssue: "NGX-450",
    targetHome: "src/core/goal/types.ts",
    reason: "Goal specification types should live beside goal behavior."
  },
  "src/goal-status.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/status.ts",
    reason: "Goal status behavior moves with goal compatibility state."
  },
  "src/handoff.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/evidence/handoff.ts",
    reason: "Goal handoff data is evidence-facing compatibility behavior."
  },
  "src/intent-apply-audits.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/intent/apply-audits.ts",
    reason: "Intent apply audit state moves with the intent domain."
  },
  "src/intent-apply-execute.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/intent/apply-execute.ts",
    reason: "Policy-gated intent apply execution moves with the intent domain."
  },
  "src/iteration-finalize.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/repo/iteration-finalize.ts",
    reason: "Iteration finalization primitives move with repo verification ownership."
  },
  "src/iteration-job.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/iteration-job.ts",
    reason: "Goal iteration job compatibility helpers move with the goal domain."
  },
  "src/iteration-prompt.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/iteration-prompt.ts",
    reason: "Goal iteration prompt helpers move with the goal domain."
  },
  "src/live-step-advance.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/live-step-advance.ts",
    reason: "Live step execution behavior moves with executor core modules."
  },
  "src/live-step-executor.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/live-step-executor.ts",
    reason: "Live step execution behavior moves with executor core modules."
  },
  "src/live-step-finalize.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/live-step-finalize.ts",
    reason: "Live step finalization behavior moves with executor core modules."
  },
  "src/live-step-orchestrator.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/live-step-orchestrator.ts",
    reason: "Live step orchestration behavior moves with executor core modules."
  },
  "src/live-step-run-recovery.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/live-step-run-recovery.ts",
    reason: "Live step recovery behavior moves with executor core modules."
  },
  "src/migrations.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/adapters/db/migrations.ts",
    reason: "SQLite migration support belongs under the database adapter seam."
  },
  "src/momentum-policy.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/intent/policy.ts",
    reason: "External-write policy checks move with intent/apply ownership."
  },
  "src/no-mistakes-mechanism.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/no-mistakes-mechanism.ts",
    reason: "No-mistakes mechanism behavior moves with executor core modules."
  },
  "src/post-apply-reconcile.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/intent/post-apply-reconcile.ts",
    reason: "Post-apply reconciliation moves with intent/apply ownership."
  },
  "src/project-rollup.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/repo/project-rollup.ts",
    reason: "Project rollup behavior is remaining repo/project domain ownership."
  },
  "src/queue-jobs.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/daemon/queue-jobs.ts",
    reason: "Queue job state moves with daemon compatibility ownership."
  },
  "src/real-smoke.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/real-smoke.ts",
    reason: "Runner smoke behavior moves with executor-family runtime behavior."
  },
  "src/real-workflow-smoke.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/real-workflow-smoke.ts",
    reason: "Workflow runner smoke behavior moves with executor-family runtime behavior."
  },
  "src/recovery-artifact.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/goal/recovery-artifact.ts",
    reason: "Goal recovery artifact helpers move with goal compatibility behavior."
  },
  "src/repo-guard.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/repo/guard.ts",
    reason: "Repo guard primitives move with repo-domain ownership."
  },
  "src/repo-locks.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/repo/locks.ts",
    reason: "Repo lock primitives move with repo-domain ownership."
  },
  "src/runner-profile.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/runner-profile.ts",
    reason: "Runner profile resolution moves with executor-family runtime behavior."
  },
  "src/runner-result.ts": {
    ownerIssue: "NGX-450",
    targetHome: "src/core/executors/types.ts",
    reason: "Runner result shapes and parsing belong beside executor behavior."
  },
  "src/single-shot-executor.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/single-shot-executor.ts",
    reason: "Single-shot execution behavior moves with executor core modules."
  },
  "src/single-shot-mechanism.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/single-shot-mechanism.ts",
    reason: "Single-shot mechanism behavior moves with executor core modules."
  },
  "src/single-shot-orchestrator.ts": {
    ownerIssue: "NGX-448",
    targetHome: "src/core/executors/single-shot-orchestrator.ts",
    reason: "Single-shot orchestration behavior moves with executor core modules."
  },
  "src/source-context.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/source/context.ts",
    reason: "Source context behavior moves with source-domain ownership."
  },
  "src/source-items.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/source/items.ts",
    reason: "Source item persistence moves with source-domain ownership."
  },
  "src/source-reconciliation-runs.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/source/reconciliation-runs.ts",
    reason: "Source reconciliation run records move with source-domain ownership."
  },
  "src/source-reconciliation.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/source/reconciliation.ts",
    reason: "Source reconciliation behavior moves with source-domain ownership."
  },
  "src/stale-recovery.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/daemon/stale-recovery.ts",
    reason: "Stale recovery behavior moves with daemon compatibility ownership."
  },
  "src/update-intent-generator.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/source/update-intent-generator.ts",
    reason: "Source-backed intent generation moves with source ownership."
  },
  "src/update-intents.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/intent/update-intents.ts",
    reason: "Update intent state moves with intent-domain ownership."
  },
  "src/verification.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/repo/verification.ts",
    reason: "Verification primitives move with repo-domain ownership."
  },
  "src/worker-run.ts": {
    ownerIssue: "NGX-449",
    targetHome: "src/core/daemon/worker-run.ts",
    reason: "Worker run compatibility behavior moves with daemon ownership."
  },
  "src/workflow-definition-persist.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/definition-persist.ts",
    reason: "Workflow definition persistence moves with workflow core ownership."
  },
  "src/workflow-definition.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/definition.ts",
    reason: "Workflow definitions move with workflow core ownership."
  },
  "src/workflow-dispatch-execute.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/dispatch-execute.ts",
    reason: "Workflow dispatch execution moves with workflow core ownership."
  },
  "src/workflow-dispatch-persist.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/dispatch-persist.ts",
    reason: "Workflow dispatch persistence moves with workflow core ownership."
  },
  "src/workflow-dispatch.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/dispatch.ts",
    reason: "Workflow dispatch planning moves with workflow core ownership."
  },
  "src/workflow-dogfood-dispatch.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/dogfood-dispatch.ts",
    reason: "Workflow dogfood dispatch helpers move with workflow core ownership."
  },
  "src/workflow-gate-persist.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/gate-persist.ts",
    reason: "Workflow gate persistence moves with workflow core ownership."
  },
  "src/workflow-gate.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/gate.ts",
    reason: "Workflow gates move with workflow core ownership."
  },
  "src/workflow-handoff.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/handoff.ts",
    reason: "Workflow handoff behavior moves with workflow core ownership."
  },
  "src/workflow-leases.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/leases.ts",
    reason: "Workflow leases move with workflow core ownership."
  },
  "src/workflow-monitor-envelope.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/monitor-envelope.ts",
    reason: "Workflow monitor envelopes move with workflow core ownership."
  },
  "src/workflow-monitor-state.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/monitor-state.ts",
    reason: "Workflow monitor state moves with workflow core ownership."
  },
  "src/workflow-recovery-artifact.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/recovery-artifact.ts",
    reason: "Workflow recovery artifacts move with workflow core ownership."
  },
  "src/workflow-recovery-reconcile.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/recovery-reconcile.ts",
    reason: "Workflow recovery reconciliation moves with workflow core ownership."
  },
  "src/workflow-run-import-persist.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/run-import-persist.ts",
    reason: "Workflow import persistence moves with workflow core ownership."
  },
  "src/workflow-run-import.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/run-import.ts",
    reason: "Workflow run import behavior moves with workflow core ownership."
  },
  "src/workflow-run-recovery.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/run-recovery.ts",
    reason: "Workflow run recovery state moves with workflow core ownership."
  },
  "src/workflow-run-reducer.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/run-reducer.ts",
    reason: "Workflow run reducer behavior moves with workflow core ownership."
  },
  "src/workflow-run-start-persist.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/run-start-persist.ts",
    reason: "Workflow run start persistence moves with workflow core ownership."
  },
  "src/workflow-run-start.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/run-start.ts",
    reason: "Workflow run start behavior moves with workflow core ownership."
  },
  "src/workflow-scheduler.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/scheduler.ts",
    reason: "Workflow scheduling behavior moves with workflow core ownership."
  },
  "src/workflow-status.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/status.ts",
    reason: "Workflow status behavior moves with workflow core ownership."
  },
  "src/workflow-step-executor.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/step-executor.ts",
    reason: "Workflow step executor registry moves with workflow core ownership."
  },
  "src/workflow-step-transitions.ts": {
    ownerIssue: "NGX-447",
    targetHome: "src/core/workflow/step-transitions.ts",
    reason: "Workflow step transition behavior moves with workflow core ownership."
  }
} satisfies Record<string, RootSrcException>;

const RENDERER_TYPE_ONLY_TRANSITIONAL_IMPORTS = new Set([
  "src/renderers/daemon.ts -> src/daemon-loop.ts",
  "src/renderers/daemon.ts -> src/daemon-runs.ts",
  "src/renderers/daemon.ts -> src/stale-recovery.ts",
  "src/renderers/evidence.ts -> src/evidence-records.ts",
  "src/renderers/evidence.ts -> src/evidence-workflow.ts",
  "src/renderers/evidence.ts -> src/update-intent-generator.ts",
  "src/renderers/goal.ts -> src/goal-init.ts",
  "src/renderers/goal.ts -> src/iteration-job.ts",
  "src/renderers/intent.ts -> src/intent-apply-audits.ts",
  "src/renderers/intent.ts -> src/momentum-policy.ts",
  "src/renderers/intent.ts -> src/update-intents.ts",
  "src/renderers/project.ts -> src/project-rollup.ts",
  "src/renderers/recovery.ts -> src/goal-recovery.ts",
  "src/renderers/source.ts -> src/source-items.ts",
  "src/renderers/source.ts -> src/source-reconciliation.ts",
  "src/renderers/source.ts -> src/source-reconciliation-runs.ts",
  "src/renderers/source.ts -> src/update-intent-generator.ts",
  "src/renderers/status.ts -> src/goal-logs.ts",
  "src/renderers/status.ts -> src/goal-status.ts",
  "src/renderers/status.ts -> src/handoff.ts",
  "src/renderers/status.ts -> src/momentum-policy.ts",
  "src/renderers/worker.ts -> src/daemon-status.ts",
  "src/renderers/worker.ts -> src/worker-run.ts",
  "src/renderers/workflow.ts -> src/workflow-gate-persist.ts",
  "src/renderers/workflow.ts -> src/workflow-handoff.ts",
  "src/renderers/workflow.ts -> src/workflow-monitor-envelope.ts",
  "src/renderers/workflow.ts -> src/workflow-monitor-state.ts",
  "src/renderers/workflow.ts -> src/workflow-recovery-reconcile.ts",
  "src/renderers/workflow.ts -> src/workflow-run-import.ts",
  "src/renderers/workflow.ts -> src/workflow-run-import-persist.ts",
  "src/renderers/workflow.ts -> src/workflow-run-recovery.ts",
  "src/renderers/workflow.ts -> src/workflow-run-start.ts",
  "src/renderers/workflow.ts -> src/workflow-run-start-persist.ts",
  "src/renderers/workflow.ts -> src/workflow-status.ts"
]);

const RENDERER_READONLY_TRANSITIONAL_IMPORTS = new Map([
  [
    "src/renderers/daemon.ts -> src/daemon-status.ts",
    new Set([
      "DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS",
      "DEFAULT_DAEMON_STALE_AFTER_MS"
    ])
  ]
]);

type ImportReference = {
  specifier: string;
  isTypeOnly: boolean;
  runtimeBindings: string[];
};

type ImportEdge = {
  from: string;
  to: string;
  specifier: string;
  isTypeOnly: boolean;
  runtimeBindings: string[];
};

function readFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

function sourceFiles(dir = srcRoot): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.relative(repoRoot, absolute));
    }
  }
  return files.sort();
}

function importEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of sourceFiles()) {
    const source = readFile(file);
    for (const reference of importReferences(file, source)) {
      const { specifier } = reference;
      if (!specifier.startsWith(".")) continue;
      edges.push({
        from: file,
        to: resolveRelativeImport(file, specifier),
        specifier,
        isTypeOnly: reference.isTypeOnly,
        runtimeBindings: reference.runtimeBindings
      });
    }
  }
  return edges;
}

function importSpecifiers(file: string, source: string): string[] {
  return importReferences(file, source).map((reference) => reference.specifier);
}

function importReferences(file: string, source: string): ImportReference[] {
  const references: ImportReference[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function addModuleSpecifier(
    moduleSpecifier: ts.Expression | undefined,
    isTypeOnly = false,
    runtimeBindings: string[] = []
  ): void {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      references.push({
        specifier: moduleSpecifier.text,
        isTypeOnly,
        runtimeBindings
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addModuleSpecifier(
        node.moduleSpecifier,
        importDeclarationIsTypeOnly(node),
        importDeclarationRuntimeBindings(node)
      );
    } else if (ts.isExportDeclaration(node)) {
      addModuleSpecifier(
        node.moduleSpecifier,
        exportDeclarationIsTypeOnly(node),
        exportDeclarationIsTypeOnly(node) ? [] : ["*"]
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      addModuleSpecifier(node.arguments[0], false, ["*"]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      references.push({
        specifier: node.argument.literal.text,
        isTypeOnly: true,
        runtimeBindings: []
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;
  if (!importClause) return false;
  if (importClause.isTypeOnly) return true;
  if (importClause.name) return false;
  const namedBindings = importClause.namedBindings;
  return (
    !!namedBindings &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.length > 0 &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function importDeclarationRuntimeBindings(node: ts.ImportDeclaration): string[] {
  const importClause = node.importClause;
  if (!importClause || importClause.isTypeOnly) return [];

  const bindings: string[] = [];
  if (importClause.name) {
    bindings.push("default");
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) return bindings;
  if (ts.isNamespaceImport(namedBindings)) {
    bindings.push("*");
    return bindings;
  }

  bindings.push(
    ...namedBindings.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text)
  );
  return bindings;
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const exportClause = node.exportClause;
  return (
    !!exportClause &&
    ts.isNamedExports(exportClause) &&
    exportClause.elements.length > 0 &&
    exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function resolveRelativeImport(file: string, specifier: string): string {
  const resolved = path.relative(
    repoRoot,
    path.resolve(path.dirname(path.join(repoRoot, file)), specifier)
  );
  return resolved.replace(/\.js$/, ".ts");
}

function commandFamily(file: string): string | null {
  const parts = file.split(path.sep);
  if (parts[0] !== "src" || parts[1] !== "commands") return null;
  if (parts[2] === "index.ts") return null;
  if (parts[2]?.endsWith(".ts")) return parts[2];
  return parts[2] ?? null;
}

function isCliEntrypoint(file: string): boolean {
  return (
    file === path.join("src", "index.ts") ||
    file === path.join("src", "cli.ts")
  );
}

function isCommandModule(file: string): boolean {
  return file === commandsDir || file.startsWith(commandsDir + path.sep);
}

function isRendererModule(file: string): boolean {
  return file === renderersDir || file.startsWith(renderersDir + path.sep);
}

function isAdapterModule(file: string): boolean {
  return file === adaptersDir || file.startsWith(adaptersDir + path.sep);
}

function isCoreModule(file: string): boolean {
  return file === coreDir || file.startsWith(coreDir + path.sep);
}

function isTransitionalRootSrcException(file: string): boolean {
  return Object.hasOwn(TRANSITIONAL_ROOT_SRC_EXCEPTIONS, file);
}

function isPersistenceOrMutationModule(file: string): boolean {
  if (isAdapterModule(file) || isTransitionalRootSrcException(file)) return true;

  return /(?:^|[/.-])(?:persist|migrations|db|lock|locks|queue|runs|records|audits|execute|finalize|reconcile|reconciliation|leases|items|intents|branch)(?:[/.-]|$)/.test(
    file
  );
}

function rendererTransitionalImportIsAllowed(edge: ImportEdge): boolean {
  if (!isTransitionalRootSrcException(edge.to)) return false;

  const key = `${edge.from} -> ${edge.to}`;
  if (edge.isTypeOnly) {
    return RENDERER_TYPE_ONLY_TRANSITIONAL_IMPORTS.has(key);
  }

  const allowedBindings = RENDERER_READONLY_TRANSITIONAL_IMPORTS.get(key);
  return (
    !!allowedBindings &&
    edge.runtimeBindings.length > 0 &&
    edge.runtimeBindings.every((binding) => allowedBindings.has(binding))
  );
}

function rootSourceFiles(): string[] {
  return fs
    .readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join("src", entry.name))
    .sort();
}

function sourceFilesUnder(relativeDir: string): string[] {
  const absolute = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  return sourceFiles(absolute);
}

describe("M11 CLI import boundaries", () => {
  it("collects all relative import forms for structural checks", () => {
    expect(
      importSpecifiers(
        "src/domain-example.ts",
        `
          import "./commands/source/index.js";
          import type { Source } from "./commands/source/index.js";
          export { render } from "./renderers/source.js";
          const lazy = import("./commands/intent/index.js");
          type Lazy = import("./renderers/intent.js").IntentJsonShape;
        `
      )
    ).toEqual([
      "./commands/source/index.js",
      "./commands/source/index.js",
      "./renderers/source.js",
      "./commands/intent/index.js",
      "./renderers/intent.js"
    ]);
  });

  it("classifies inline type-only named imports without treating mixed imports as type-only", () => {
    expect(
      importReferences(
        "src/renderers/example.ts",
        `
          import { type SourceItem } from "../source-items.js";
          export { type WorkflowRunImport } from "../workflow-run-import.js";
          import { write, type CliIo } from "./cli-output.js";
          import DefaultExport, { type GoalSpec } from "../goal-spec.js";
        `
      )
    ).toEqual([
      {
        specifier: "../source-items.js",
        isTypeOnly: true,
        runtimeBindings: []
      },
      {
        specifier: "../workflow-run-import.js",
        isTypeOnly: true,
        runtimeBindings: []
      },
      {
        specifier: "./cli-output.js",
        isTypeOnly: false,
        runtimeBindings: ["write"]
      },
      {
        specifier: "../goal-spec.js",
        isTypeOnly: false,
        runtimeBindings: ["default"]
      }
    ]);
  });

  it("classifies all transitional root source modules as renderer runtime boundaries", () => {
    expect(isPersistenceOrMutationModule("src/artifacts.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/branch-manager.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/goal-init.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/handoff.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/source-reconciliation.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/update-intent-generator.ts")).toBe(true);
  });

  it("allows only explicit renderer transitional imports", () => {
    const updateIntentTypeEdge: ImportEdge = {
      from: "src/renderers/evidence.ts",
      to: "src/update-intent-generator.ts",
      specifier: "../update-intent-generator.js",
      isTypeOnly: true,
      runtimeBindings: []
    };
    expect(rendererTransitionalImportIsAllowed(updateIntentTypeEdge)).toBe(true);
    expect(
      rendererTransitionalImportIsAllowed({
        ...updateIntentTypeEdge,
        isTypeOnly: false,
        runtimeBindings: ["evaluateGoalForSourceSatisfiedIntent"]
      })
    ).toBe(false);

    const daemonStatusReadonlyEdge: ImportEdge = {
      from: "src/renderers/daemon.ts",
      to: "src/daemon-status.ts",
      specifier: "../daemon-status.js",
      isTypeOnly: false,
      runtimeBindings: [
        "DEFAULT_DAEMON_ACTIVE_JOB_STALE_AFTER_MS",
        "DEFAULT_DAEMON_STALE_AFTER_MS"
      ]
    };
    expect(rendererTransitionalImportIsAllowed(daemonStatusReadonlyEdge)).toBe(true);
    expect(
      rendererTransitionalImportIsAllowed({
        ...daemonStatusReadonlyEdge,
        runtimeBindings: ["loadDaemonStatus"]
      })
    ).toBe(false);
  });

  it("enforces the durable root src allowlist with named transitional debt", () => {
    expect(DURABLE_ROOT_SRC_ALLOWLIST).toEqual([
      "src/index.ts",
      "src/cli.ts",
      "src/suppress-sqlite-experimental-warning.ts",
      "src/node-shims.d.ts"
    ]);

    const allowed = new Set([
      ...DURABLE_ROOT_SRC_ALLOWLIST,
      ...Object.keys(TRANSITIONAL_ROOT_SRC_EXCEPTIONS)
    ]);
    const unexpectedRootFiles = rootSourceFiles().filter((file) => !allowed.has(file));

    expect(
      unexpectedRootFiles,
      "New root src/*.ts files must move into src/core/<domain>, src/config, src/shared, src/adapters, src/commands, or src/renderers; if migration debt is unavoidable, add a named transitional exception with owner issue, target home, and reason."
    ).toEqual([]);

    const staleExceptions = Object.keys(TRANSITIONAL_ROOT_SRC_EXCEPTIONS).filter(
      (file) => !fs.existsSync(path.join(repoRoot, file))
    );
    expect(
      staleExceptions,
      "Remove transitional root allowlist entries after their file moves."
    ).toEqual([]);

    const malformedExceptions = Object.entries(TRANSITIONAL_ROOT_SRC_EXCEPTIONS)
      .filter(([, exception]) => {
        return (
          !/^NGX-(?:447|448|449|450)$/.test(exception.ownerIssue) ||
          !/^src\/(?:core\/(?:workflow|executors|goal|source|intent|daemon|repo|evidence)\/|config\/|shared\/|adapters\/)/.test(
            exception.targetHome
          ) ||
          exception.reason.trim().length < 20
        );
      })
      .map(([file]) => file);

    expect(
      malformedExceptions,
      "Each transitional root src exception must name NGX-447/448/449/450, a target taxonomy home, and a practical removal reason."
    ).toEqual([]);
  });

  it("keeps source taxonomy directories real and placeholder-free", () => {
    const existingTaxonomyDirs = [commandsDir, renderersDir, adaptersDir];
    for (const dir of existingTaxonomyDirs) {
      const files = sourceFilesUnder(dir);
      expect(files.length, `${dir} should contain real TypeScript modules`).toBeGreaterThan(0);
    }

    for (const pendingDir of [coreDir, configDir, sharedDir]) {
      const absolute = path.join(repoRoot, pendingDir);
      if (!fs.existsSync(absolute)) continue;

      const files = sourceFilesUnder(pendingDir);
      expect(
        files.length,
        `${pendingDir} is pending taxonomy; do not create placeholder-only directories.`
      ).toBeGreaterThan(0);
      expect(
        files.filter((file) => /(?:placeholder|todo|stub|junk|example)/i.test(file)),
        `${pendingDir} should contain real ownership modules, not placeholder junk.`
      ).toEqual([]);
    }

    const documentedTargetPrefixes = new Set(
      Object.values(TRANSITIONAL_ROOT_SRC_EXCEPTIONS).map((exception) =>
        exception.targetHome.split("/").slice(0, 3).join("/")
      )
    );
    expect([...documentedTargetPrefixes].sort()).toEqual([
      "src/adapters/db",
      "src/config/data-dir.ts",
      "src/core/daemon",
      "src/core/evidence",
      "src/core/executors",
      "src/core/goal",
      "src/core/intent",
      "src/core/repo",
      "src/core/source",
      "src/core/workflow",
      "src/shared/events.ts"
    ]);
  });

  it("keeps core/domain modules independent from commands and renderers", () => {
    const violations = importEdges().filter((edge) => {
      if (
        isCliEntrypoint(edge.from) ||
        isCommandModule(edge.from) ||
        isRendererModule(edge.from)
      ) {
        return false;
      }
      return isCommandModule(edge.to) || isRendererModule(edge.to);
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; move CLI formatting behind src/commands or src/renderers instead of importing it from core/domain code.`
      )
    ).toEqual([]);
  });

  it("keeps future src/core modules independent from command and renderer layers", () => {
    const violations = importEdges().filter(
      (edge) =>
        isCoreModule(edge.from) &&
        (isCommandModule(edge.to) || isRendererModule(edge.to))
    );

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; core modules own behavior and must not import command parsing or rendering layers.`
      )
    ).toEqual([]);
  });

  it("prevents renderers from importing commands, adapters, or runtime mutation modules", () => {
    const violations = importEdges().filter((edge) => {
      if (!isRendererModule(edge.from)) return false;
      const forbidden =
        isCommandModule(edge.to) ||
        isAdapterModule(edge.to) ||
        isPersistenceOrMutationModule(edge.to);
      if (!forbidden) return false;
      return !rendererTransitionalImportIsAllowed(edge);
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; renderers must accept computed results and type-only shapes instead of importing commands, adapters, persistence, or mutation modules.`
      )
    ).toEqual([]);
  });

  it("prevents command families from importing sibling command families for render shapes", () => {
    const violations = importEdges().filter((edge) => {
      const fromFamily = commandFamily(edge.from);
      const toFamily = commandFamily(edge.to);
      return fromFamily !== null && toFamily !== null && fromFamily !== toFamily;
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; shared JSON/text shapes belong in src/renderers, not another command family.`
      )
    ).toEqual([]);
  });

  it("keeps direct stdout/stderr process access in CLI or rendering layers", () => {
    const violations = sourceFiles().filter((file) => {
      if (isCliEntrypoint(file) || isRendererModule(file)) return false;
      return /process\.(?:stdout|stderr)/.test(readFile(file));
    });

    expect(
      violations.map(
        (file) =>
          `${file} reads process stdout/stderr directly; thread output through CliIo and src/renderers instead.`
      )
    ).toEqual([]);
  });

  it("keeps infrastructure-facing adapters under src/adapters ownership", () => {
    const expectedAdapters = [
      "src/adapters/db.ts",
      "src/adapters/external-update-adapter.ts",
      "src/adapters/git-transaction.ts",
      "src/adapters/linear-external-update-client.ts",
      "src/adapters/linear-http-client.ts",
      "src/adapters/linear-issue-refresh.ts",
      "src/adapters/acp-config.ts",
      "src/adapters/acp-runner.ts",
      "src/adapters/fake-runner.ts",
      "src/adapters/live-step-wrapper.ts",
      "src/adapters/live-wrapper-registry.ts",
      "src/adapters/source-adapter.ts",
      "src/adapters/linear-source-adapter.ts",
      "src/adapters/runner-adapter.ts",
      "src/adapters/trusted-shell-config.ts",
      "src/adapters/trusted-shell-runner.ts",
      "src/adapters/no-mistakes-executor.ts",
      "src/adapters/no-mistakes-orchestrator.ts",
      "src/adapters/real-workflow-probe.ts"
    ];

    expect(
      expectedAdapters.filter((file) => !fs.existsSync(path.join(repoRoot, file))),
      "NGX-417 adapter/infrastructure modules should have clear ownership under src/adapters"
    ).toEqual([]);

    const rootInfrastructureModules = [
      "src/db.ts",
      "src/external-update-adapter.ts",
      "src/git-transaction.ts",
      "src/linear-external-update-client.ts",
      "src/linear-http-client.ts",
      "src/linear-issue-refresh.ts",
      "src/acp-config.ts",
      "src/acp-runner.ts",
      "src/fake-runner.ts",
      "src/live-step-wrapper.ts",
      "src/live-wrapper-registry.ts",
      "src/source-adapter.ts",
      "src/linear-source-adapter.ts",
      "src/runner-adapter.ts",
      "src/trusted-shell-config.ts",
      "src/trusted-shell-runner.ts",
      "src/no-mistakes-executor.ts",
      "src/no-mistakes-orchestrator.ts",
      "src/real-workflow-probe.ts"
    ];

    expect(
      rootInfrastructureModules.filter((file) =>
        fs.existsSync(path.join(repoRoot, file))
      ),
      "NGX-417 adapter/infrastructure modules should not remain as flat src/ modules after ownership migration"
    ).toEqual([]);
  });

  it("prevents adapters from importing commands or renderers", () => {
    const violations = importEdges().filter(
      (edge) =>
        isAdapterModule(edge.from) &&
        (isCommandModule(edge.to) || isRendererModule(edge.to))
    );

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; adapters must stay independent from CLI commands and renderers.`
      )
    ).toEqual([]);
  });

  it("keeps src/cli.ts thin after command-family extraction", () => {
    const lineCount = readFile("src/cli.ts").split("\n").length;

    expect(
      lineCount,
      "src/cli.ts should stay below 3000 lines after M11 extraction"
    ).toBeLessThan(3000);
  });

  it("documents how to add a command module without crossing boundaries", () => {
    const architecture = readFile("ARCHITECTURE.md");

    expect(architecture).toContain("## Adding a Command Module");
    expect(architecture).toMatch(/Do not import sibling command famil/i);
    expect(architecture).toContain("src/renderers/");
    expect(architecture).toMatch(/src\/cli\.ts.*dispatch/s);
  });

  it("documents how to add future source modules without creating root junk", () => {
    const standard = readFile("internal/contracts/repo-architecture-standard.md");

    expect(standard).toContain("## Adding Source Modules During ARCH Migration");
    expect(standard).toMatch(/Do not add new root `src\/\*\.ts` modules/i);
    expect(standard).toMatch(/src\/core\/<domain>/);
    expect(standard).toMatch(/transitional exception/i);
  });
});
