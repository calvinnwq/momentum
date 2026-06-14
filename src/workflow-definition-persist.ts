/**
 * Persistence layer for M10-01 (NGX-345) workflow / step definition primitives.
 *
 * Takes the pure {@link WorkflowDefinition} shape owned by
 * `workflow-definition.ts` and writes it into the durable
 * `workflow_definitions` / `step_definitions` tables added by `migrations.ts`.
 * This is the storage twin of the pure validator: nothing here runs executors
 * or schedules work. First-class run start is layered separately on these
 * persisted definitions.
 *
 * Stable contracts this slice locks in:
 *   - A definition's durable identity is `(key, version)`; a step's is
 *     `(definition_key, definition_version, step_key)`. Re-persisting the same
 *     definition is idempotent — it never produces duplicate rows.
 *   - Persistence is validation-gated: an invalid definition is rejected by
 *     {@link validateWorkflowDefinition} and throws an
 *     {@link InvalidWorkflowDefinitionError} *before* any row is written, so a
 *     bad definition can never leave partial state behind.
 *   - `created_at` is preserved across re-persists; `updated_at` is bumped on
 *     every upsert so callers can detect re-ingest.
 *   - The persisted step set exactly mirrors the definition: re-persisting a
 *     `(key, version)` with a step removed deletes the orphaned step row, so a
 *     loaded definition always round-trips to what was last persisted.
 */

import type { MomentumDb } from "./adapters/db.js";
import {
  BUILT_IN_WORKFLOW_DEFINITIONS,
  validateWorkflowDefinition,
  type StepDefinition,
  type WorkflowDefinition,
  type WorkflowDefinitionValidationError,
  type WorkflowExecutorFamily
} from "./workflow-definition.js";
import type { WorkflowStepKind } from "./workflow-run-reducer.js";

/**
 * Thrown by {@link persistWorkflowDefinition} when the supplied value is not a
 * valid {@link WorkflowDefinition}. Carries the full typed error list so callers
 * can surface a complete diagnostic.
 */
export class InvalidWorkflowDefinitionError extends Error {
  readonly errors: readonly WorkflowDefinitionValidationError[];

  constructor(errors: readonly WorkflowDefinitionValidationError[]) {
    super(
      `Invalid workflow definition: ${errors.map((e) => e.code).join(", ")}`
    );
    this.name = "InvalidWorkflowDefinitionError";
    this.errors = errors;
  }
}

export type PersistWorkflowDefinitionOptions = {
  now?: number;
};

export type PersistWorkflowDefinitionSummary = {
  key: string;
  version: number;
  title: string;
  inserted: boolean;
  stepCount: number;
};

/**
 * Validate and durably upsert a {@link WorkflowDefinition} and its steps.
 *
 * @throws {InvalidWorkflowDefinitionError} if `definition` fails validation; no
 * rows are written in that case.
 */
export function persistWorkflowDefinition(
  db: MomentumDb,
  definition: unknown,
  options: PersistWorkflowDefinitionOptions = {}
): PersistWorkflowDefinitionSummary {
  const validation = validateWorkflowDefinition(definition);
  if (!validation.ok) {
    throw new InvalidWorkflowDefinitionError(validation.errors);
  }
  const def = validation.definition;
  const now = options.now ?? Date.now();

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare(
        "SELECT key FROM workflow_definitions WHERE key = ? AND version = ?"
      )
      .get(def.key, def.version) as { key: string } | undefined;
    const inserted = existing === undefined;

    db.prepare(
      `INSERT INTO workflow_definitions
         (key, version, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key, version) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at`
    ).run(def.key, def.version, def.title, now, now);

    const stepStmt = db.prepare(
      `INSERT INTO step_definitions
         (definition_key, definition_version, step_key, kind, executor,
          step_order, required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(definition_key, definition_version, step_key) DO UPDATE SET
         kind = excluded.kind,
         executor = excluded.executor,
         step_order = excluded.step_order,
         required = excluded.required,
         updated_at = excluded.updated_at`
    );
    for (const step of def.steps) {
      stepStmt.run(
        def.key,
        def.version,
        step.key,
        step.kind,
        step.executor,
        step.order,
        step.required ? 1 : 0,
        now,
        now
      );
    }

    // Drop any step rows for this version that the current definition no longer
    // declares, so the persisted set mirrors the definition exactly. A valid
    // definition always has at least one step, so the IN-list is never empty.
    const keepKeys = def.steps.map((step) => step.key);
    const placeholders = keepKeys.map(() => "?").join(", ");
    db.prepare(
      `DELETE FROM step_definitions
         WHERE definition_key = ? AND definition_version = ?
           AND step_key NOT IN (${placeholders})`
    ).run(def.key, def.version, ...keepKeys);

    db.exec("COMMIT");
    return {
      key: def.key,
      version: def.version,
      title: def.title,
      inserted,
      stepCount: def.steps.length
    };
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/**
 * Load a persisted {@link WorkflowDefinition} back into its pure shape. When
 * `version` is omitted the highest persisted version for `key` is returned.
 * Returns `undefined` when no matching definition exists.
 */
export function loadWorkflowDefinition(
  db: MomentumDb,
  key: string,
  version?: number
): WorkflowDefinition | undefined {
  let resolvedVersion = version;
  if (resolvedVersion === undefined) {
    const row = db
      .prepare(
        "SELECT MAX(version) AS version FROM workflow_definitions WHERE key = ?"
      )
      .get(key) as { version: number | null } | undefined;
    if (row?.version == null) return undefined;
    resolvedVersion = row.version;
  }

  const defRow = db
    .prepare(
      "SELECT key, version, title FROM workflow_definitions WHERE key = ? AND version = ?"
    )
    .get(key, resolvedVersion) as
    | { key: string; version: number; title: string }
    | undefined;
  if (defRow === undefined) return undefined;

  const stepRows = db
    .prepare(
      `SELECT step_key, kind, executor, step_order, required
         FROM step_definitions
         WHERE definition_key = ? AND definition_version = ?
         ORDER BY step_order, step_key`
    )
    .all(key, resolvedVersion) as Array<{
    step_key: string;
    kind: string;
    executor: string;
    step_order: number;
    required: number;
  }>;

  const steps: StepDefinition[] = stepRows.map((row) => ({
    key: row.step_key,
    kind: row.kind as WorkflowStepKind,
    executor: row.executor as WorkflowExecutorFamily,
    order: row.step_order,
    required: row.required === 1
  }));

  return {
    key: defRow.key,
    title: defRow.title,
    version: defRow.version,
    steps
  };
}

/**
 * List the distinct persisted workflow definition keys, ordered by key.
 */
export function listWorkflowDefinitionKeys(db: MomentumDb): string[] {
  const rows = db
    .prepare("SELECT DISTINCT key FROM workflow_definitions ORDER BY key")
    .all() as Array<{ key: string }>;
  return rows.map((row) => row.key);
}

/**
 * Persist every built-in {@link WorkflowDefinition} (currently the coding
 * workflow). Idempotent: re-seeding upserts in place rather than duplicating.
 */
export function seedBuiltInWorkflowDefinitions(
  db: MomentumDb,
  options: PersistWorkflowDefinitionOptions = {}
): PersistWorkflowDefinitionSummary[] {
  return BUILT_IN_WORKFLOW_DEFINITIONS.map((definition) =>
    persistWorkflowDefinition(db, definition, options)
  );
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Already rolled back / not in transaction; nothing to do.
  }
}
