export const ROUTE_STATE_MIGRATION_ERROR_CODES = [
  "route_state_schema_partial",
  "route_state_canonical_conflict",
  "route_state_json_malformed",
  "route_state_not_object",
  "route_state_unknown_key",
  "route_state_value_invalid",
  "route_state_source_conflict",
  "route_state_profile_ambiguous",
  "route_state_step_target_missing",
  "route_state_step_target_ambiguous",
  "route_state_subworkflow_target_missing",
  "route_state_lineage_invalid",
  "route_state_lineage_parent_missing",
  "route_state_projection_mismatch",
  "route_state_foreign_key_invalid",
] as const;

export type RouteStateMigrationErrorCode =
  (typeof ROUTE_STATE_MIGRATION_ERROR_CODES)[number];

export class RouteStateMigrationError extends Error {
  readonly runId: string;
  readonly jsonPath: string;
  readonly code: RouteStateMigrationErrorCode;
  readonly repair: string;

  constructor(input: {
    runId: string;
    jsonPath: string;
    code: RouteStateMigrationErrorCode;
    detail: string;
    repair?: string;
  }) {
    const repair =
      input.repair ??
      "Restore this database from backup or manually repair the named route value before reopening Momentum.";
    super(
      `Route-state migration refused for run '${input.runId}' at ${input.jsonPath} ` +
        `[${input.code}]: ${input.detail} ${repair}`,
    );
    this.name = "RouteStateMigrationError";
    this.runId = input.runId;
    this.jsonPath = input.jsonPath;
    this.code = input.code;
    this.repair = repair;
  }
}
