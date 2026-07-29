import type { MomentumDb } from "../../../adapters/db.js";
import { RouteStateMigrationError } from "../../../adapters/db/route-state-errors.js";
import {
  type CodingStepExecutorSelection,
  type CodingStepRouteOverride,
} from "./coding.js";
import {
  mergePortableAgentConfig,
  PORTABLE_AGENT_CONFIG_FIELDS,
} from "../../../shared/agent-config.js";

type AgentConfigField = (typeof PORTABLE_AGENT_CONFIG_FIELDS)[number];

type CanonicalAgentConfigRow = {
  step_id: string;
  agent_config_json: string | null;
};

export type CanonicalWorkflowStepAgentConfig = CodingStepRouteOverride;

/**
 * Read the frozen agent selection owned by one persisted workflow step.
 *
 * This is the active selection reader for native execution and read models.
 * The legacy route projection may expose the same value for compatibility, but
 * it is never consulted here.
 */
export function readCanonicalWorkflowStepAgentConfig(
  db: MomentumDb,
  input: { runId: string; stepId: string },
): CodingStepRouteOverride {
  const row = db
    .prepare(
      `SELECT step_id, agent_config_json
         FROM workflow_steps
        WHERE run_id = ? AND step_id = ?`,
    )
    .get(input.runId, input.stepId) as CanonicalAgentConfigRow | undefined;
  if (row === undefined) {
    throw canonicalConfigError(
      input.runId,
      input.stepId,
      "canonical workflow step row is missing",
    );
  }
  return parseCanonicalWorkflowStepAgentConfig(
    input.runId,
    input.stepId,
    row.agent_config_json,
  );
}

/** Read every frozen agent selection for a run through the same strict reader. */
export function readCanonicalWorkflowStepAgentConfigs(
  db: MomentumDb,
  runId: string,
): Map<string, CodingStepRouteOverride> {
  const rows = db
    .prepare(
      `SELECT step_id, agent_config_json
         FROM workflow_steps
        WHERE run_id = ?
        ORDER BY step_order, step_id`,
    )
    .all(runId) as CanonicalAgentConfigRow[];
  return new Map(
    rows.map((row) => [
      row.step_id,
      parseCanonicalWorkflowStepAgentConfig(
        runId,
        row.step_id,
        row.agent_config_json,
      ),
    ]),
  );
}

/** Convert a frozen step config to the executor-facing selection fields. */
export function canonicalWorkflowStepExecutorSelection(
  config: CodingStepRouteOverride,
): CodingStepExecutorSelection {
  return {
    agentProvider: config.harness ?? null,
    model: config.model ?? null,
    effort: config.effort ?? null,
  };
}

export function parseCanonicalWorkflowStepAgentConfig(
  runId: string,
  stepId: string,
  raw: string | null,
): CodingStepRouteOverride {
  if (raw === null) {
    throw canonicalConfigError(runId, stepId, "canonical agent config is null");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw canonicalConfigError(
      runId,
      stepId,
      "canonical agent config JSON is malformed",
    );
  }
  if (!isPlainObject(parsed)) {
    throw canonicalConfigError(
      runId,
      stepId,
      "canonical agent config must be an object",
    );
  }

  const normalized: CodingStepRouteOverride = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(PORTABLE_AGENT_CONFIG_FIELDS as readonly string[]).includes(key)) {
      throw canonicalConfigError(
        runId,
        stepId,
        `canonical agent config field '${key}' is unsupported`,
      );
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw canonicalConfigError(
        runId,
        stepId,
        `canonical agent config field '${key}' must be a non-blank string`,
      );
    }
    normalized[key as AgentConfigField] = value.trim();
  }
  return mergePortableAgentConfig({}, normalized);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalConfigError(
  runId: string,
  stepId: string,
  detail: string,
): RouteStateMigrationError {
  return new RouteStateMigrationError({
    runId,
    jsonPath: `$.steps.${stepId}.agentConfig`,
    code: "route_state_value_invalid",
    detail,
    repair:
      "Restore the frozen workflow_steps.agent_config_json value to a strict { harness?, model?, effort? } object before retrying.",
  });
}
