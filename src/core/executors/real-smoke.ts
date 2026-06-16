/**
 * Opt-in real adapter smoke harness — planning and outcome classification
 * (NGX-372 / Adapter Test Coverage milestone).
 *
 * This module owns the CI-safe decision logic for the *first* adapter test
 * layer allowed to touch a real external system: a read-only Linear source
 * read. It never performs network I/O itself — it only:
 *
 *   - decides whether the real smoke may run at all, given operator-controlled
 *     environment variables (`planLinearReadSmoke`), and
 *   - maps a finished `reconcileLinearSource` result into a documented
 *     failure-mode taxonomy (`classifyRealSmokeReadOutcome`).
 *
 * Safety posture:
 *   - The smoke is **skipped unless explicitly opted in** with a credential, so
 *     default CI never reaches a real `api.linear.app` call.
 *   - The smoke is **read-only**. It composes the read-side
 *     `LinearReconciliationClient`; it never constructs an external-write
 *     adapter, so no comment/status mutation is reachable from here.
 *   - It bounds the read to a small page count by default to keep the smoke
 *     cheap, and supports a no-persist dry-run mode.
 *   - Invalid configuration fails closed (skip), never runs with bad input.
 */

import { LINEAR_API_KEY_ENV_VAR } from "../../intent-apply-execute.js";
import type {
  LinearReconciliationFilters,
  ReconcileLinearSourceResult
} from "../../source-reconciliation.js";

/** Master opt-in switch. The real Linear read smoke skips unless this is truthy. */
export const REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR = "MOMENTUM_REAL_SMOKE_LINEAR";
/** Enables the no-persist dry-run mode (still performs the real read). */
export const REAL_SMOKE_DRY_RUN_ENV_VAR = "MOMENTUM_REAL_SMOKE_DRY_RUN";
/** Optional read-only project scope (UUID -> projectId, else projectName). */
export const REAL_SMOKE_LINEAR_PROJECT_ENV_VAR = "MOMENTUM_REAL_SMOKE_LINEAR_PROJECT";
/** Optional read-only milestone scope (UUID -> milestoneId, else milestoneName). */
export const REAL_SMOKE_LINEAR_MILESTONE_ENV_VAR = "MOMENTUM_REAL_SMOKE_LINEAR_MILESTONE";
/** Optional bound on pages drained; defaults to a small, cheap read. */
export const REAL_SMOKE_LINEAR_MAX_PAGES_ENV_VAR = "MOMENTUM_REAL_SMOKE_LINEAR_MAX_PAGES";
/** Optional GraphQL endpoint override (e.g. to point a dry-run at a mock). */
export const REAL_SMOKE_LINEAR_ENDPOINT_ENV_VAR = "MOMENTUM_REAL_SMOKE_LINEAR_ENDPOINT";
/** Override the evidence output directory; defaults to `.agent-runs/real-smoke/`. */
export const REAL_SMOKE_EVIDENCE_DIR_ENV_VAR = "MOMENTUM_REAL_SMOKE_EVIDENCE_DIR";

/** A single bounded read keeps the opt-in smoke cheap and connectivity-focused. */
export const DEFAULT_REAL_SMOKE_LINEAR_MAX_PAGES = 1;

export type RealSmokeReadSkipReason =
  | "not_opted_in"
  | "missing_credentials"
  | "config_invalid";

export type RealSmokeReadPlan =
  | { mode: "skip"; reason: RealSmokeReadSkipReason; detail: string }
  | {
      mode: "run";
      apiKey: string;
      dryRun: boolean;
      filters: LinearReconciliationFilters;
      endpoint: string | null;
      maxPages: number;
    };

/**
 * Decide whether the opt-in real Linear read smoke may run, and with what
 * read-only parameters. Pure: reads only the provided environment snapshot.
 */
export function planLinearReadSmoke(
  env: Record<string, string | undefined>
): RealSmokeReadPlan {
  if (!isEnvFlagEnabled(env[REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR])) {
    return {
      mode: "skip",
      reason: "not_opted_in",
      detail: `${REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR} is not set; the real Linear read smoke stays off by default and never runs in CI.`
    };
  }

  const apiKey = (env[LINEAR_API_KEY_ENV_VAR] ?? "").trim();
  if (apiKey.length === 0) {
    return {
      mode: "skip",
      reason: "missing_credentials",
      detail: `${LINEAR_API_KEY_ENV_VAR} is unset; the real Linear read smoke needs an operator-provided read credential.`
    };
  }

  const maxPages = resolveMaxPages(env[REAL_SMOKE_LINEAR_MAX_PAGES_ENV_VAR]);
  if (maxPages === null) {
    return {
      mode: "skip",
      reason: "config_invalid",
      detail: `${REAL_SMOKE_LINEAR_MAX_PAGES_ENV_VAR} must be a positive integer; refusing to run with invalid configuration.`
    };
  }

  const endpointRaw = (env[REAL_SMOKE_LINEAR_ENDPOINT_ENV_VAR] ?? "").trim();
  return {
    mode: "run",
    apiKey,
    dryRun: isEnvFlagEnabled(env[REAL_SMOKE_DRY_RUN_ENV_VAR]),
    filters: buildSmokeFilters(env),
    endpoint: endpointRaw.length > 0 ? endpointRaw : null,
    maxPages
  };
}

export type RealSmokeReadFailureMode =
  | "auth_failure"
  | "rate_limited"
  | "network_failure"
  | "tool_unavailable"
  | "config_invalid"
  | "adapter_error";

export type RealSmokeReadOutcome =
  | { ok: true; itemsObserved: number; pages: number }
  | {
      ok: false;
      mode: RealSmokeReadFailureMode;
      code: string;
      detail: string;
    };

/**
 * Map a finished `reconcileLinearSource` result into the documented real-smoke
 * failure-mode taxonomy. Pure: inspects only the reconciliation result.
 */
export function classifyRealSmokeReadOutcome(
  result: ReconcileLinearSourceResult
): RealSmokeReadOutcome {
  const stop = result.paginationStopped;
  if (stop.reason === "complete" || stop.reason === "max_pages") {
    return {
      ok: true,
      itemsObserved: result.counts.itemsObserved,
      pages: result.counts.pages
    };
  }

  const code = stop.code ?? "source_adapter_threw";
  const detail = stop.error ?? result.run.error ?? "linear read smoke failed";

  return {
    ok: false,
    mode: classifyFailureMode(code, detail),
    code,
    detail
  };
}

function classifyFailureMode(code: string, detail: string): RealSmokeReadFailureMode {
  if (code === "source_auth_unavailable") return "auth_failure";

  const text = detail.toLowerCase();
  if (/rate.?limit|too many request|\b429\b/.test(text)) return "rate_limited";
  if (/global fetch is unavailable/.test(text)) return "tool_unavailable";

  if (code === "source_config_invalid") return "config_invalid";

  if (
    /(timed out|fetch failed|getaddrinfo|socket hang up|network|econnrefused|econnreset|enotfound|etimedout|eai_again)/.test(
      text
    )
  ) {
    return "network_failure";
  }

  return "adapter_error";
}

function buildSmokeFilters(
  env: Record<string, string | undefined>
): LinearReconciliationFilters {
  const filters: LinearReconciliationFilters = {};

  const project = (env[REAL_SMOKE_LINEAR_PROJECT_ENV_VAR] ?? "").trim();
  if (project.length > 0) {
    if (looksLikeUuid(project)) filters.projectId = project;
    else filters.projectName = project;
  }

  const milestone = (env[REAL_SMOKE_LINEAR_MILESTONE_ENV_VAR] ?? "").trim();
  if (milestone.length > 0) {
    if (looksLikeUuid(milestone)) filters.milestoneId = milestone;
    else filters.milestoneName = milestone;
  }

  return filters;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f-]{8,}$/i.test(value) && value.includes("-");
}

function resolveMaxPages(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_REAL_SMOKE_LINEAR_MAX_PAGES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
