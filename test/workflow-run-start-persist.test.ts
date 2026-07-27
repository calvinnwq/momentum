import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import {
  WORKFLOW_RUN_START_SOURCE,
  type WorkflowRunStartInput,
} from "../src/core/workflow/run/start.js";
import {
  InvalidWorkflowRunStartError,
  WorkflowRunStartConflictError,
  persistWorkflowRunStart,
} from "../src/core/workflow/run/start-persist.js";

const NOW = 1_700_000_000_000;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-run-start-persist-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function openTempDb(): MomentumDb {
  return openDb(makeTempDir());
}

function twoStepDefinition(): WorkflowDefinition {
  return {
    key: "sample-workflow",
    title: "Sample Workflow",
    version: 3,
    steps: [
      {
        key: "implementation",
        kind: "implementation",
        executor: "agent-loop",
        order: 1,
        required: true,
      },
      {
        key: "preflight",
        kind: "preflight",
        executor: "agent-once",
        order: 0,
        required: false,
      },
    ],
  };
}

function subworkflowDefinition(key: string): WorkflowDefinition {
  return {
    key,
    title: `${key} definition`,
    version: 1,
    steps: [
      {
        key: "dispatch",
        kind: "implementation",
        executor: "subworkflow",
        order: 0,
        required: true,
      },
    ],
  };
}

function baseInput(
  overrides: Partial<WorkflowRunStartInput> = {},
): WorkflowRunStartInput {
  return {
    definition: twoStepDefinition(),
    runId: "run-001",
    repoPath: "/repos/momentum",
    objective: "Implement NGX-346",
    now: NOW,
    ...overrides,
  };
}

type RunRow = {
  id: string;
  state: string;
  source: string;
  goal_id: string | null;
  repo_path: string | null;
  objective: string | null;
  issue_scope_json: string;
  route_json: string;
  approval_boundary: string | null;
  skill_revision: string | null;
  workflow_definition_key: string | null;
  workflow_definition_version: number | null;
  plan_json: string;
  needs_manual_recovery: number;
  started_at: number | null;
  created_at: number;
  updated_at: number;
};

function loadRunRow(db: MomentumDb, runId: string): RunRow | undefined {
  return db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as
    RunRow | undefined;
}

type StepRow = {
  step_id: string;
  kind: string;
  state: string;
  step_order: number;
  required: number;
  created_at: number;
  updated_at: number;
};

function loadStepRows(db: MomentumDb, runId: string): StepRow[] {
  return db
    .prepare(
      "SELECT step_id, kind, state, step_order, required, created_at, updated_at FROM workflow_steps WHERE run_id = ? ORDER BY step_order, step_id",
    )
    .all(runId) as StepRow[];
}

type ApprovalRow = {
  run_id: string;
  boundary: string;
  actor: string | null;
  phrase: string;
  artifact_path: string;
  artifact_digest: string;
  recorded_at: number;
  discharged_at: number | null;
};

function loadApprovalRows(db: MomentumDb, runId: string): ApprovalRow[] {
  return db
    .prepare(
      "SELECT run_id, boundary, actor, phrase, artifact_path, artifact_digest, recorded_at, discharged_at FROM workflow_approvals WHERE run_id = ? ORDER BY boundary",
    )
    .all(runId) as ApprovalRow[];
}

describe("persistWorkflowRunStart", () => {
  it("persists the workflow run row linked back to its definition", () => {
    const db = openTempDb();
    try {
      const summary = persistWorkflowRunStart(db, baseInput());
      expect(summary).toEqual({
        runId: "run-001",
        source: WORKFLOW_RUN_START_SOURCE,
        state: "pending",
        approvalBoundary: null,
        definitionKey: "sample-workflow",
        definitionVersion: 3,
        route: {},
        implementationEngine: null,
        stepCount: 2,
        inserted: true,
      });

      const row = loadRunRow(db, "run-001");
      expect(row).toBeDefined();
      expect(row?.state).toBe("pending");
      expect(row?.source).toBe(WORKFLOW_RUN_START_SOURCE);
      expect(row?.goal_id).toBeNull();
      expect(row?.repo_path).toBe("/repos/momentum");
      expect(row?.objective).toBe("Implement NGX-346");
      expect(row?.issue_scope_json).toBe("{}");
      expect(row?.route_json).toBe("{}");
      expect(row?.approval_boundary).toBeNull();
      expect(row?.skill_revision).toBeNull();
      expect(row?.workflow_definition_key).toBe("sample-workflow");
      expect(row?.workflow_definition_version).toBe(3);
      expect(row?.needs_manual_recovery).toBe(0);
      expect(row?.started_at).toBeNull();
      expect(row?.created_at).toBe(NOW);
      expect(row?.updated_at).toBe(NOW);
    } finally {
      db.close();
    }
  });

  it("persists step rows in definition order with materialized state", () => {
    const db = openTempDb();
    try {
      persistWorkflowRunStart(db, baseInput());
      const steps = loadStepRows(db, "run-001");
      expect(
        steps.map((s) => ({
          step_id: s.step_id,
          kind: s.kind,
          state: s.state,
          step_order: s.step_order,
          required: s.required,
        })),
      ).toEqual([
        {
          step_id: "preflight",
          kind: "preflight",
          state: "pending",
          step_order: 0,
          required: 0,
        },
        {
          step_id: "implementation",
          kind: "implementation",
          state: "pending",
          step_order: 1,
          required: 1,
        },
      ]);
      expect(
        steps.every((s) => s.created_at === NOW && s.updated_at === NOW),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("freezes definition and route config into explicit step destinations", () => {
    const db = openTempDb();
    try {
      const definition = twoStepDefinition();
      definition.steps[0]!.agentConfig = {
        harness: "codex",
        model: "gpt-5.6",
      };
      definition.steps[0]!.config = { command: "implement" };
      persistWorkflowRunStart(
        db,
        baseInput({
          definition,
          route: {
            steps: {
              implementation: { model: "gpt-5.6-codex", effort: "medium" },
            },
          },
        }),
      );

      expect(
        db
          .prepare(
            `SELECT agent_config_json, executor_config_json
               FROM workflow_steps
              WHERE run_id = 'run-001' AND step_id = 'implementation'`,
          )
          .get(),
      ).toEqual({
        agent_config_json:
          '{"harness":"codex","model":"gpt-5.6-codex","effort":"medium"}',
        executor_config_json: '{"command":"implement"}',
      });
    } finally {
      db.close();
    }
  });

  it("refuses divergent agent configs for repeated step kinds before writing", () => {
    const db = openTempDb();
    try {
      const definition = twoStepDefinition();
      definition.steps[0]!.agentConfig = { harness: "codex" };
      definition.steps[1]!.kind = "implementation";
      definition.steps[1]!.agentConfig = { harness: "claude" };

      expect(() =>
        persistWorkflowRunStart(db, baseInput({ definition })),
      ).toThrow(InvalidWorkflowRunStartError);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_runs WHERE id = 'run-001'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("persists equal agent configs for repeated step kinds", () => {
    const db = openTempDb();
    try {
      const definition = twoStepDefinition();
      definition.steps[0]!.agentConfig = { harness: "codex" };
      definition.steps[1]!.kind = "implementation";
      definition.steps[1]!.agentConfig = { harness: "codex" };

      expect(
        persistWorkflowRunStart(
          db,
          baseInput({
            definition,
            route: {
              steps: {
                implementation: { model: "gpt-5.6", effort: "medium" },
              },
            },
          }),
        ).inserted,
      ).toBe(true);
      expect(
        db
          .prepare(
            `SELECT step_id, agent_config_json
               FROM workflow_steps
              WHERE run_id = 'run-001'
              ORDER BY step_id`,
          )
          .all(),
      ).toEqual([
        {
          step_id: "implementation",
          agent_config_json:
            '{"harness":"codex","model":"gpt-5.6","effort":"medium"}',
        },
        {
          step_id: "preflight",
          agent_config_json:
            '{"harness":"codex","model":"gpt-5.6","effort":"medium"}',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("refuses canonical and legacy route aliases before writing", () => {
    const db = openTempDb();
    try {
      let refusal: InvalidWorkflowRunStartError | undefined;
      try {
        persistWorkflowRunStart(
          db,
          baseInput({
            route: {
              steps: {
                "no-mistakes": { harness: "claude" },
                validate: { harness: "codex" },
              },
            },
          }),
        );
      } catch (error) {
        refusal = error as InvalidWorkflowRunStartError;
      }
      expect(refusal).toBeInstanceOf(InvalidWorkflowRunStartError);
      expect(refusal?.errors).toEqual([
        expect.objectContaining({
          code: "route_invalid",
          path: "$.steps.validate",
        }),
      ]);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_runs WHERE id = 'run-001'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("refuses unmatched route step targets before writing", () => {
    const db = openTempDb();
    try {
      let refusal: InvalidWorkflowRunStartError | undefined;
      try {
        persistWorkflowRunStart(
          db,
          baseInput({
            route: {
              steps: {
                validate: { harness: "codex" },
              },
            },
          }),
        );
      } catch (error) {
        refusal = error as InvalidWorkflowRunStartError;
      }
      expect(refusal).toBeInstanceOf(InvalidWorkflowRunStartError);
      expect(refusal?.errors).toEqual([
        expect.objectContaining({
          code: "route_invalid",
          path: "$.steps.validate",
        }),
      ]);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_runs WHERE id = 'run-001'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("refuses unknown route keys before writing a run", () => {
    const db = openTempDb();
    try {
      expect(() =>
        persistWorkflowRunStart(db, baseInput({ route: { unknown: "value" } })),
      ).toThrow(InvalidWorkflowRunStartError);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_runs WHERE id = 'run-001'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("refuses duplicate lineage ancestors before writing a run", () => {
    const db = openTempDb();
    try {
      expect(() =>
        persistWorkflowRunStart(
          db,
          baseInput({
            route: {
              subworkflow: {
                lineage: {
                  parentRunId: "parent-run",
                  parentStepId: "child",
                  depth: 2,
                  ancestorDefinitionKeys: [
                    "parent-workflow",
                    "parent-workflow",
                  ],
                },
              },
            },
          }),
        ),
      ).toThrow(InvalidWorkflowRunStartError);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM workflow_runs WHERE id = 'run-001'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("refuses fresh lineage that disagrees with a canonical parent chain", () => {
    const db = openTempDb();
    try {
      const grandparentDefinition = subworkflowDefinition(
        "grandparent-workflow",
      );
      const parentDefinition = subworkflowDefinition("parent-workflow");
      persistWorkflowDefinition(db, grandparentDefinition, { now: NOW });
      persistWorkflowDefinition(db, parentDefinition, { now: NOW });
      persistWorkflowRunStart(
        db,
        baseInput({
          definition: grandparentDefinition,
          runId: "grandparent-run",
        }),
      );
      persistWorkflowRunStart(
        db,
        baseInput({
          definition: parentDefinition,
          runId: "parent-run",
          route: {
            subworkflow: {
              lineage: {
                parentRunId: "grandparent-run",
                parentStepId: "dispatch",
                depth: 1,
                ancestorDefinitionKeys: ["grandparent-workflow"],
              },
            },
          },
        }),
      );

      db.exec(`
        CREATE TRIGGER reject_child_run_insert
        BEFORE INSERT ON workflow_runs
        WHEN NEW.id = 'child-run'
        BEGIN
          SELECT RAISE(FAIL, 'workflow run insert reached');
        END
      `);
      let refusal: InvalidWorkflowRunStartError | undefined;
      try {
        persistWorkflowRunStart(
          db,
          baseInput({
            runId: "child-run",
            route: {
              subworkflow: {
                lineage: {
                  parentRunId: "parent-run",
                  parentStepId: "dispatch",
                  depth: 2,
                  ancestorDefinitionKeys: [
                    "grandparent-workflow",
                    "wrong-workflow",
                  ],
                },
              },
            },
          }),
        );
      } catch (error) {
        if (error instanceof InvalidWorkflowRunStartError) refusal = error;
        else throw error;
      }
      expect(refusal).toBeDefined();
      expect(refusal?.errors).toContainEqual(
        expect.objectContaining({
          code: "route_invalid",
          path: "$.subworkflow.lineage.ancestorDefinitionKeys",
        }),
      );
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?")
          .get("child-run"),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("persists the built-in coding workflow with honoured scope, route, and skill revision", () => {
    const db = openTempDb();
    try {
      const summary = persistWorkflowRunStart(
        db,
        baseInput({
          definition: CODING_WORKFLOW_DEFINITION,
          issueScope: { issues: ["NGX-346"] },
          route: { profile: "fixture-profile" },
          source: "workflow-definition",
          skillRevision: "abc123",
        }),
      );
      expect(summary.definitionKey).toBe("coding-workflow");
      expect(summary.source).toBe("workflow-definition");
      expect(summary.stepCount).toBe(CODING_WORKFLOW_DEFINITION.steps.length);

      const row = loadRunRow(db, "run-001");
      expect(row?.issue_scope_json).toBe(
        JSON.stringify({ issues: ["NGX-346"] }),
      );
      expect(row?.route_json).toBe("{}");
      expect(row?.skill_revision).toBe("abc123");
      expect(row?.source).toBe("workflow-definition");
      expect(
        db
          .prepare(
            `SELECT implementation_engine, selected_profile
               FROM workflow_run_coding_compatibility
              WHERE run_id = 'run-001'`,
          )
          .get(),
      ).toEqual({
        implementation_engine: null,
        selected_profile: "fixture-profile",
      });

      const steps = loadStepRows(db, "run-001");
      expect(steps.map((s) => s.kind)).toEqual([
        "preflight",
        "implementation",
        "postflight",
        "validate",
        "merge-cleanup",
        "tracker-refresh",
      ]);
    } finally {
      db.close();
    }
  });

  it("promotes approved steps and records the approval boundary plus run state", () => {
    const db = openTempDb();
    try {
      const summary = persistWorkflowRunStart(
        db,
        baseInput({
          definition: CODING_WORKFLOW_DEFINITION,
          approvalBoundary: "implementation",
        }),
      );
      expect(summary.state).toBe("approved");
      expect(summary.approvalBoundary).toBe("implementation");

      const row = loadRunRow(db, "run-001");
      expect(row?.state).toBe("approved");
      expect(row?.approval_boundary).toBe("implementation");

      const byKind = new Map(
        loadStepRows(db, "run-001").map((s) => [s.kind, s.state]),
      );
      expect(byKind.get("preflight")).toBe("approved");
      expect(byKind.get("implementation")).toBe("approved");
      expect(byKind.get("postflight")).toBe("pending");
      expect(byKind.get("validate")).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("persists approval-boundary starts as durable approval coverage", () => {
    const db = openTempDb();
    try {
      persistWorkflowRunStart(
        db,
        baseInput({
          definition: CODING_WORKFLOW_DEFINITION,
          approvalBoundary: "implementation",
          source: "operator-cli",
        }),
      );

      const approvals = loadApprovalRows(db, "run-001");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        run_id: "run-001",
        boundary: "implementation",
        actor: "operator-cli",
        phrase: "workflow run start --approval-boundary implementation",
        artifact_path: "workflow-run-start://run-001/implementation",
        recorded_at: NOW,
        discharged_at: null,
      });
      expect(approvals[0]?.artifact_digest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  });

  it("throws InvalidWorkflowRunStartError and writes nothing for invalid input", () => {
    const db = openTempDb();
    try {
      let thrown: unknown;
      try {
        persistWorkflowRunStart(db, baseInput({ definition: {}, runId: "" }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidWorkflowRunStartError);
      const codes = (thrown as InvalidWorkflowRunStartError).errors.map(
        (e) => e.code,
      );
      expect(codes).toContain("definition_invalid");
      expect(codes).toContain("run_id_invalid");

      const count = db
        .prepare("SELECT count(*) AS c FROM workflow_runs")
        .get() as { c: number };
      expect(count.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses to clobber an existing run and leaves it untouched", () => {
    const db = openTempDb();
    try {
      persistWorkflowRunStart(db, baseInput());

      let thrown: unknown;
      try {
        persistWorkflowRunStart(
          db,
          baseInput({ objective: "A different objective", now: NOW + 5000 }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkflowRunStartConflictError);
      expect((thrown as WorkflowRunStartConflictError).runId).toBe("run-001");

      const row = loadRunRow(db, "run-001");
      expect(row?.objective).toBe("Implement NGX-346");
      expect(row?.updated_at).toBe(NOW);
    } finally {
      db.close();
    }
  });

  it("maps run insert uniqueness races to the run-start conflict error", () => {
    const uniqueError = new Error("UNIQUE constraint failed: workflow_runs.id");
    const fakeDb = {
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => {
        if (sql.includes("SELECT id FROM workflow_runs")) {
          return { get: vi.fn(() => undefined) };
        }
        if (sql.includes("INSERT INTO workflow_runs")) {
          return {
            run: vi.fn(() => {
              throw uniqueError;
            }),
          };
        }
        return { run: vi.fn() };
      }),
    } as unknown as MomentumDb;

    let thrown: unknown;
    try {
      persistWorkflowRunStart(fakeDb, baseInput());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkflowRunStartConflictError);
    expect((thrown as WorkflowRunStartConflictError).runId).toBe("run-001");
  });
});
