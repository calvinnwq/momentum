import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TAG = "v0.22.0";
const RELEASE_COMMIT = "ebde7a3fe14ab135375b7cf724f383a838949b1c";
const FIXED_NOW = 1_753_430_400_000;
const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/v0220-route-state.sql",
);

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: Buffer;
    capture?: boolean;
  } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture
      ? ["pipe", "pipe", "inherit"]
      : options.input
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${String(result.status)}.`,
    );
  }
  return options.capture ? String(result.stdout).trim() : "";
}

function assertReleasedTreeImport(
  releasedRoot: string,
  modulePath: string,
): string {
  const resolved = path.resolve(releasedRoot, "dist", modulePath);
  const distRoot = path.resolve(releasedRoot, "dist") + path.sep;
  if (!resolved.startsWith(distRoot)) {
    throw new Error(`Released-tree import escaped dist/: ${resolved}`);
  }
  return pathToFileURL(resolved).href;
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const resolvedCommit = run("git", ["rev-parse", TAG], {
  cwd: repositoryRoot,
  capture: true,
});
if (resolvedCommit !== RELEASE_COMMIT) {
  throw new Error(
    `${TAG} resolved to ${resolvedCommit}; expected ${RELEASE_COMMIT}.`,
  );
}

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "momentum-v0220-route-fixture-"),
);
try {
  const archive = spawnSync("git", ["archive", TAG], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (archive.error) throw archive.error;
  if (archive.status !== 0 || archive.stdout === null) {
    throw new Error(`git archive ${TAG} failed.`);
  }
  run("tar", ["-x", "-C", tempRoot], { input: archive.stdout });
  const installedDependencies = path.join(repositoryRoot, "node_modules");
  if (!fs.existsSync(installedDependencies)) {
    throw new Error(
      "The isolated offline build requires the baseline node_modules tree.",
    );
  }
  fs.cpSync(installedDependencies, path.join(tempRoot, "node_modules"), {
    recursive: true,
  });
  run(
    "pnpm",
    ["install", "--frozen-lockfile", "--offline", "--lockfile-only"],
    { cwd: tempRoot },
  );
  run("pnpm", ["build"], { cwd: tempRoot });

  const helperPath = path.join(tempRoot, "generate-route-fixture.mjs");
  const databasePath = path.join(tempRoot, "fixture", "momentum.db");
  const imports = {
    db: assertReleasedTreeImport(tempRoot, "adapters/db.js"),
    definition: assertReleasedTreeImport(
      tempRoot,
      "core/workflow/definition/definition.js",
    ),
    definitionPersist: assertReleasedTreeImport(
      tempRoot,
      "core/workflow/definition/persist.js",
    ),
    startPersist: assertReleasedTreeImport(
      tempRoot,
      "core/workflow/run/start-persist.js",
    ),
    importPersist: assertReleasedTreeImport(
      tempRoot,
      "core/workflow/run/import-persist.js",
    ),
  };

  fs.writeFileSync(
    helperPath,
    `import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from ${JSON.stringify(imports.db)};
import {
  CODING_WORKFLOW_DEFINITION,
  CODING_WORKFLOW_DEFINITION_V1,
} from ${JSON.stringify(imports.definition)};
import {
  persistWorkflowDefinition,
  seedBuiltInWorkflowDefinitions,
} from ${JSON.stringify(imports.definitionPersist)};
import { persistWorkflowRunStart } from ${JSON.stringify(imports.startPersist)};
import { persistWorkflowRunImport } from ${JSON.stringify(imports.importPersist)};

const dataDir = ${JSON.stringify(path.dirname(databasePath))};
const now = ${FIXED_NOW};
fs.mkdirSync(dataDir, { recursive: true });
let db = openDb(dataDir);
seedBuiltInWorkflowDefinitions(db, { now });

const leafDefinition = {
  key: "fixture-leaf",
  title: "Fixture leaf",
  version: 1,
  steps: [
    {
      key: "work",
      kind: "implementation",
      executor: "script",
      config: { command: "true" },
      order: 0,
      required: true,
    },
  ],
};
const nestedDefinition = {
  key: "fixture-nested",
  title: "Fixture nested",
  version: 1,
  steps: [
    {
      key: "nested-child",
      kind: "implementation",
      executor: "subworkflow",
      order: 0,
      required: true,
    },
  ],
};
const parentDefinition = {
  key: "fixture-parent",
  title: "Fixture parent",
  version: 1,
  steps: [
    {
      key: "child-one",
      kind: "implementation",
      executor: "subworkflow",
      order: 0,
      required: true,
    },
    {
      key: "child-two",
      kind: "postflight",
      executor: "subworkflow",
      order: 1,
      required: true,
    },
  ],
};
for (const definition of [
  leafDefinition,
  nestedDefinition,
  parentDefinition,
]) {
  persistWorkflowDefinition(db, definition, { now });
}

function start({
  runId,
  definition = CODING_WORKFLOW_DEFINITION,
  source = "momentum-native-coding",
  route = {},
}) {
  persistWorkflowRunStart(db, {
    definition,
    runId,
    repoPath: "/repos/fixture",
    objective: "Released v0.22.0 route fixture",
    now,
    issueScope: { id: "FIXTURE-1" },
    route,
    source,
  });
}

start({
  runId: "native-simple",
  route: { implementationEngine: "gnhf" },
});
start({
  runId: "native-full",
  route: {
    implementationEngine: "native-goal-loop",
    profile: "fixture-native",
    steps: {
      implementation: {
        harness: "codex",
        model: "gpt-5.6",
        effort: "medium",
      },
      postflight: { harness: "claude", model: "opus", effort: "high" },
      validate: { harness: "codex" },
      "merge-cleanup": { model: "cleanup-model" },
      "tracker-refresh": { effort: "low" },
    },
  },
});
start({
  runId: "native-current-cwfp",
  route: { implementationEngine: "current-gnhf-cwfp" },
});
start({
  runId: "generic-profile",
  source: "workflow-definition",
  route: { profile: "fixture-generic" },
});
start({
  runId: "v1-aliases",
  definition: CODING_WORKFLOW_DEFINITION_V1,
  route: {
    steps: {
      "no-mistakes": { harness: "codex", model: "gpt-5.6" },
      "linear-refresh": { effort: "medium" },
    },
  },
});
start({
  runId: "subworkflow-parent",
  definition: parentDefinition,
  source: "workflow-definition",
  route: {
    subworkflow: {
      child: {
        childDefinitionKey: "fixture-nested",
        childDefinitionVersion: 1,
        maxDepth: 3,
      },
    },
  },
});
start({
  runId: "subworkflow-child",
  definition: nestedDefinition,
  source: "workflow-definition",
  route: {
    subworkflow: {
      lineage: {
        parentRunId: "subworkflow-parent",
        parentStepId: "child-one",
        depth: 1,
        ancestorDefinitionKeys: ["fixture-parent"],
      },
    },
  },
});
start({
  runId: "subworkflow-grandchild",
  definition: leafDefinition,
  source: "workflow-definition",
  route: {
    subworkflow: {
      lineage: {
        parentRunId: "subworkflow-child",
        parentStepId: "nested-child",
        depth: 2,
        ancestorDefinitionKeys: ["fixture-parent", "fixture-nested"],
      },
    },
  },
});
start({
  runId: "empty-route",
  source: "workflow-definition",
  route: {},
});

persistWorkflowRunImport(
  db,
  {
    run: {
      runId: "cwfp-imported",
      source: "agent-workflow",
      sourceArtifactPath: "/fixtures/cwfp-imported",
      planJson: { mode: "implementation" },
      repoPath: "/repos/fixture",
      objective: "Imported fixture",
      issueScope: { id: "FIXTURE-2" },
      route: {
        mode: "implementation",
        profile: "fixture-import",
        risk: "medium",
        quotaPolicy: { maxTurns: 12, overflow: "refuse" },
      },
      approvalBoundary: null,
      skillRevision: "fixture",
      state: "pending",
    },
    steps: [
      {
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 0,
        required: true,
        startedAt: null,
        finishedAt: null,
        ledgerOffset: null,
        errorCode: null,
        errorMessage: null,
      },
    ],
    approvals: [],
    leases: [],
    monitor: null,
    diagnostics: [],
  },
  { now },
);

db.close();
db = openDb(dataDir);
db.close();

const dumpDb = new DatabaseSync(${JSON.stringify(databasePath)}, {
  readOnly: true,
});
const forbidden = [
  "agent_config_json",
  "executor_config_json",
  "workflow_run_lineage",
  "workflow_run_coding_compatibility",
  "workflow_run_import_metadata",
];
const schemaFingerprint = dumpDb
  .prepare(
    "SELECT group_concat(sql, char(10)) AS sql FROM sqlite_master WHERE sql IS NOT NULL",
  )
  .get().sql ?? "";
for (const token of forbidden) {
  if (schemaFingerprint.includes(token)) {
    throw new Error("Released fixture unexpectedly contains " + token + ".");
  }
}

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}
function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (Buffer.isBuffer(value)) return "X'" + value.toString("hex") + "'";
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "'" + String(value).replaceAll("'", "''") + "'";
}

const schemaRows = dumpDb
  .prepare(
    \`SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,
                name\`,
  )
  .all();
const tables = schemaRows.filter((row) => row.type === "table");
const secondarySchema = schemaRows.filter((row) => row.type !== "table");
const lines = ["PRAGMA foreign_keys = OFF;", "BEGIN;"];
for (const row of tables) lines.push(row.sql + ";");
for (const table of tables) {
  const columns = dumpDb
    .prepare("PRAGMA table_info(" + quoteIdentifier(table.name) + ")")
    .all();
  const names = columns.map((column) => column.name);
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => quoteIdentifier(column.name));
  const orderBy =
    primaryKey.length > 0 ? primaryKey.join(", ") : "rowid";
  const rows = dumpDb
    .prepare(
      "SELECT * FROM " +
        quoteIdentifier(table.name) +
        " ORDER BY " +
        orderBy,
    )
    .all();
  for (const row of rows) {
    lines.push(
      "INSERT INTO " +
        quoteIdentifier(table.name) +
        " (" +
        names.map(quoteIdentifier).join(", ") +
        ") VALUES (" +
        names.map((name) => sqlLiteral(row[name])).join(", ") +
        ");",
    );
  }
}
for (const row of secondarySchema) lines.push(row.sql + ";");
lines.push("COMMIT;", "PRAGMA foreign_keys = ON;", "");
process.stdout.write(lines.join("\\n"));
dumpDb.close();
`,
    "utf8",
  );

  const dumpBody = run(process.execPath, [helperPath], {
    cwd: tempRoot,
    capture: true,
  });
  const body = `${dumpBody}\n`;
  const bodyDigest = crypto.createHash("sha256").update(body).digest("hex");
  const nodeVersion = run(process.execPath, ["--version"], {
    capture: true,
  });
  const pnpmVersion = run("pnpm", ["--version"], { capture: true });
  const releaseDate = run("git", ["show", "-s", "--format=%cI", TAG], {
    cwd: repositoryRoot,
    capture: true,
  });
  const header = [
    `-- Momentum released route-state fixture`,
    `-- tag: ${TAG}`,
    `-- commit: ${RELEASE_COMMIT}`,
    `-- node: ${nodeVersion}`,
    `-- pnpm: ${pnpmVersion}`,
    `-- reproducible-generation-date: ${releaseDate}`,
    `-- body-sha256: ${bodyDigest}`,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, header + body, "utf8");
  process.stdout.write(`${OUTPUT_PATH}\n${bodyDigest}\n`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
