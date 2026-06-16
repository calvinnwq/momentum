import { describe, expect, it } from "vitest";

import {
  DEFAULT_REAL_SMOKE_LINEAR_MAX_PAGES,
  REAL_SMOKE_DRY_RUN_ENV_VAR,
  REAL_SMOKE_LINEAR_ENDPOINT_ENV_VAR,
  REAL_SMOKE_LINEAR_MAX_PAGES_ENV_VAR,
  REAL_SMOKE_LINEAR_MILESTONE_ENV_VAR,
  REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR,
  REAL_SMOKE_LINEAR_PROJECT_ENV_VAR,
  classifyRealSmokeReadOutcome,
  planLinearReadSmoke
} from "../src/core/executors/real-smoke.js";
import { LINEAR_API_KEY_ENV_VAR } from "../src/core/intent/apply-execute.js";
import type {
  LinearReconciliationStop,
  ReconcileLinearSourceResult
} from "../src/core/source/reconciliation.js";

/**
 * NGX-372 opt-in real adapter smoke harness — pure planner / classifier.
 *
 * These tests pin the CI-safe decision logic that gates the real Linear read
 * smoke (skip unless explicitly opted in with a credential) and the documented
 * failure-mode taxonomy (auth / rate-limit / network / tool-unavailable /
 * config / adapter), with no network or persistence involved.
 */

function optedInEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    [REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR]: "1",
    [LINEAR_API_KEY_ENV_VAR]: "lin_api_secret",
    ...overrides
  };
}

function makeResult(
  paginationStopped: LinearReconciliationStop,
  overrides: { itemsObserved?: number; pages?: number; runError?: string | null } = {}
): ReconcileLinearSourceResult {
  const pages = overrides.pages ?? 1;
  const itemsObserved = overrides.itemsObserved ?? 0;
  const failed =
    paginationStopped.reason !== "complete" && paginationStopped.reason !== "max_pages";
  return {
    run: {
      id: "run-1",
      adapterKind: "linear",
      state: failed ? "failed" : "succeeded",
      startedAt: 1_000,
      finishedAt: 2_000,
      error: overrides.runError ?? (failed ? "boom" : null),
      itemsSeen: itemsObserved,
      itemsUpserted: 0,
      metadata: {},
      createdAt: 1_000,
      updatedAt: 2_000
    },
    counts: {
      pages,
      itemsObserved,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsSkipped: 0,
      itemsErrored: 0
    },
    items: [],
    paginationStopped
  };
}

describe("planLinearReadSmoke (NGX-372)", () => {
  it("skips with not_opted_in when the opt-in flag is unset", () => {
    const plan = planLinearReadSmoke({ [LINEAR_API_KEY_ENV_VAR]: "lin_api_secret" });
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("not_opted_in");
  });

  it("skips with not_opted_in when the opt-in flag is a falsy string", () => {
    for (const value of ["0", "false", "no", "off", ""]) {
      const plan = planLinearReadSmoke(
        optedInEnv({ [REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR]: value })
      );
      expect(plan.mode, `value=${JSON.stringify(value)}`).toBe("skip");
      if (plan.mode !== "skip") throw new Error("expected skip");
      expect(plan.reason).toBe("not_opted_in");
    }
  });

  it("skips with missing_credentials when opted in without a Linear API key", () => {
    const plan = planLinearReadSmoke({ [REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR]: "1" });
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("missing_credentials");
  });

  it("skips with missing_credentials when the API key is whitespace only", () => {
    const plan = planLinearReadSmoke(
      optedInEnv({ [LINEAR_API_KEY_ENV_VAR]: "   " })
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("missing_credentials");
  });

  it("runs with safe bounded defaults when opted in with a credential", () => {
    const plan = planLinearReadSmoke(optedInEnv());
    expect(plan.mode).toBe("run");
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.apiKey).toBe("lin_api_secret");
    expect(plan.dryRun).toBe(false);
    expect(plan.maxPages).toBe(DEFAULT_REAL_SMOKE_LINEAR_MAX_PAGES);
    expect(plan.filters).toEqual({});
    expect(plan.endpoint).toBeNull();
  });

  it("trims the credential before handing it to the runner", () => {
    const plan = planLinearReadSmoke(
      optedInEnv({ [LINEAR_API_KEY_ENV_VAR]: "  lin_api_secret  " })
    );
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.apiKey).toBe("lin_api_secret");
  });

  it("enables the no-op dry-run mode when the dry-run flag is truthy", () => {
    const plan = planLinearReadSmoke(
      optedInEnv({ [REAL_SMOKE_DRY_RUN_ENV_VAR]: "true" })
    );
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.dryRun).toBe(true);
  });

  it("maps a UUID-shaped project to projectId and a plain string to projectName", () => {
    const byId = planLinearReadSmoke(
      optedInEnv({
        [REAL_SMOKE_LINEAR_PROJECT_ENV_VAR]: "b66052d1-7b17-4650-813c-802c264477b8"
      })
    );
    if (byId.mode !== "run") throw new Error("expected run");
    expect(byId.filters).toEqual({ projectId: "b66052d1-7b17-4650-813c-802c264477b8" });

    const byName = planLinearReadSmoke(
      optedInEnv({ [REAL_SMOKE_LINEAR_PROJECT_ENV_VAR]: "Momentum" })
    );
    if (byName.mode !== "run") throw new Error("expected run");
    expect(byName.filters).toEqual({ projectName: "Momentum" });
  });

  it("maps a UUID-shaped milestone to milestoneId and a plain string to milestoneName", () => {
    const byId = planLinearReadSmoke(
      optedInEnv({
        [REAL_SMOKE_LINEAR_MILESTONE_ENV_VAR]: "9bc330f7-21c3-40ab-811e-671823fe24b0"
      })
    );
    if (byId.mode !== "run") throw new Error("expected run");
    expect(byId.filters).toEqual({ milestoneId: "9bc330f7-21c3-40ab-811e-671823fe24b0" });

    const byName = planLinearReadSmoke(
      optedInEnv({ [REAL_SMOKE_LINEAR_MILESTONE_ENV_VAR]: "Adapter Test Coverage" })
    );
    if (byName.mode !== "run") throw new Error("expected run");
    expect(byName.filters).toEqual({ milestoneName: "Adapter Test Coverage" });
  });

  it("honors endpoint and max-pages overrides", () => {
    const plan = planLinearReadSmoke(
      optedInEnv({
        [REAL_SMOKE_LINEAR_ENDPOINT_ENV_VAR]: "https://mock.test/graphql",
        [REAL_SMOKE_LINEAR_MAX_PAGES_ENV_VAR]: "3"
      })
    );
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.endpoint).toBe("https://mock.test/graphql");
    expect(plan.maxPages).toBe(3);
  });

  it("fails closed with config_invalid when max-pages is not a positive integer", () => {
    for (const value of ["0", "-2", "abc", "1.5"]) {
      const plan = planLinearReadSmoke(
        optedInEnv({ [REAL_SMOKE_LINEAR_MAX_PAGES_ENV_VAR]: value })
      );
      expect(plan.mode, `value=${value}`).toBe("skip");
      if (plan.mode !== "skip") throw new Error("expected skip");
      expect(plan.reason).toBe("config_invalid");
    }
  });
});

describe("classifyRealSmokeReadOutcome (NGX-372)", () => {
  it("reports ok when pagination drains to completion", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({ reason: "complete", pageIndex: 1 }, { itemsObserved: 4 })
    );
    expect(outcome).toEqual({ ok: true, itemsObserved: 4, pages: 1 });
  });

  it("reports ok when stopped at the max-pages bound", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({ reason: "max_pages", pageIndex: 1 }, { itemsObserved: 2 })
    );
    expect(outcome.ok).toBe(true);
  });

  it("classifies an auth-unavailable stop as auth_failure", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({
        reason: "auth_unavailable",
        pageIndex: 1,
        code: "source_auth_unavailable",
        error: "Linear API rejected credentials (HTTP 401)."
      })
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("auth_failure");
  });

  it("classifies a rate-limited adapter error as rate_limited", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({
        reason: "adapter_threw",
        pageIndex: 1,
        code: "source_adapter_threw",
        error: "Linear API returned HTTP 429."
      })
    );
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("rate_limited");
  });

  it("classifies a transport timeout / connection error as network_failure", () => {
    for (const error of [
      "linear http request timed out after 30000ms",
      "linear http transport failed: fetch failed",
      "linear http transport failed: getaddrinfo ENOTFOUND api.linear.app"
    ]) {
      const outcome = classifyRealSmokeReadOutcome(
        makeResult({
          reason: "adapter_threw",
          pageIndex: 1,
          code: "source_adapter_threw",
          error
        })
      );
      if (outcome.ok) throw new Error(`expected failure for ${error}`);
      expect(outcome.mode, error).toBe("network_failure");
    }
  });

  it("classifies a missing global fetch as tool_unavailable", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({
        reason: "config_invalid",
        pageIndex: 1,
        code: "source_config_invalid",
        error:
          "global fetch is unavailable; pass options.fetch to buildLinearHttpReconciliationClient."
      })
    );
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("tool_unavailable");
  });

  it("classifies other config failures as config_invalid", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({
        reason: "config_invalid",
        pageIndex: 1,
        code: "source_config_invalid",
        error: "linear http page size must be an integer in [1, 250], got 999"
      })
    );
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("config_invalid");
  });

  it("classifies an unrecognized adapter error as adapter_error", () => {
    const outcome = classifyRealSmokeReadOutcome(
      makeResult({
        reason: "adapter_threw",
        pageIndex: 1,
        code: "source_adapter_threw",
        error: "linear http response data.issues.nodes was not an array"
      })
    );
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("adapter_error");
  });
});
