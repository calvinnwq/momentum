import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { buildLinearHttpReconciliationClient } from "../src/adapters/linear-http-client.js";
import { reconcileLinearSource } from "../src/core/source/reconciliation.js";
import { listSourceItems } from "../src/core/source/items.js";
import {
  REAL_SMOKE_EVIDENCE_DIR_ENV_VAR,
  REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR,
  classifyRealSmokeReadOutcome,
  planLinearReadSmoke,
} from "../src/core/executors/smoke/linear-read.js";

/**
 * NGX-372 opt-in real Linear read smoke (Adapter Test Coverage milestone).
 *
 * This is the first adapter test allowed to touch a real external system. It is
 * **skipped unless an operator explicitly opts in** via
 * `MOMENTUM_REAL_SMOKE_LINEAR=1` with a `LINEAR_API_KEY` set, so default CI never
 * reaches `api.linear.app`. When opted in it performs exactly one (or a small,
 * bounded count of) read-only Linear `issues` page reads through the existing
 * read-side reconciliation client into a disposable temp data dir, classifies
 * the outcome against the documented failure-mode taxonomy, and records evidence
 * under `.agent-runs/real-smoke/` (gitignored, so the repo stays clean).
 *
 * It is read-only by construction: it composes only the read-side
 * `LinearReconciliationClient`; no external-write adapter is reachable from here.
 *
 * Manual run:
 *   MOMENTUM_REAL_SMOKE_LINEAR=1 LINEAR_API_KEY=lin_api_... \
 *     pnpm vitest run --config vitest.integration.config.ts test/real-linear-read-smoke.test.ts
 *
 * Optional read-only scoping / safety knobs:
 *   MOMENTUM_REAL_SMOKE_DRY_RUN=1            # read but never persist locally
 *   MOMENTUM_REAL_SMOKE_LINEAR_PROJECT=...   # UUID -> projectId, else projectName
 *   MOMENTUM_REAL_SMOKE_LINEAR_MILESTONE=... # UUID -> milestoneId, else milestoneName
 *   MOMENTUM_REAL_SMOKE_LINEAR_MAX_PAGES=2   # bound the drain (default 1)
 *   MOMENTUM_REAL_SMOKE_LINEAR_ENDPOINT=...  # override endpoint (e.g. a mock)
 */

const plan = planLinearReadSmoke(process.env);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-ngx-372-real-smoke-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function recordEvidence(
  label: string,
  payload: Record<string, unknown>,
): string {
  const baseDir =
    process.env[REAL_SMOKE_EVIDENCE_DIR_ENV_VAR]?.trim() ||
    path.join(process.cwd(), ".agent-runs", "real-smoke");
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, `${label}-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

describe.skipIf(plan.mode === "skip")(
  "NGX-372 opt-in real Linear read smoke",
  () => {
    it("performs a bounded read-only Linear reconcile and records evidence", async () => {
      // The skipIf guard guarantees this branch; the assertion narrows the type.
      if (plan.mode !== "run") {
        throw new Error("unreachable: skipIf guards the run mode");
      }

      const dataDir = makeTempDir();
      const db: MomentumDb = openDb(dataDir);
      try {
        const clientOptions: Parameters<
          typeof buildLinearHttpReconciliationClient
        >[0] = {
          apiKey: plan.apiKey,
        };
        if (plan.endpoint !== null) clientOptions.endpoint = plan.endpoint;
        const client = buildLinearHttpReconciliationClient(clientOptions);

        const result = await reconcileLinearSource(db, {
          client,
          filters: plan.filters,
          dryRun: plan.dryRun,
          maxPages: plan.maxPages,
        });

        const outcome = classifyRealSmokeReadOutcome(result);
        const items = listSourceItems(db, { adapterKind: "linear" });

        const evidencePath = recordEvidence("linear-read", {
          issue: "NGX-372",
          smoke: "opt-in-real-linear-read",
          dryRun: plan.dryRun,
          maxPages: plan.maxPages,
          filters: plan.filters,
          endpoint: plan.endpoint,
          runState: result.run.state,
          counts: result.counts,
          paginationStopped: result.paginationStopped,
          outcome,
          itemsPersisted: plan.dryRun ? 0 : items.length,
        });
        console.log(
          `[NGX-372 real smoke] outcome=${JSON.stringify(outcome)} evidence=${evidencePath}`,
        );

        expect(
          outcome.ok,
          `real Linear read failed: ${JSON.stringify(outcome)}`,
        ).toBe(true);

        // Read smoke leaves the repo clean: the only durable footprint is the
        // disposable temp SQLite database (and its sidecar files).
        for (const entry of fs.readdirSync(dataDir)) {
          expect(
            entry.startsWith("momentum.db"),
            `real read smoke wrote an unexpected file: ${entry}`,
          ).toBe(true);
        }
        expect(fs.existsSync(path.join(dataDir, ".git"))).toBe(false);

        // Dry-run never persists; a live read persists only into source_* tables.
        if (plan.dryRun) {
          expect(items).toHaveLength(0);
        }
      } finally {
        db.close();
      }
    });
  },
);

// Always-on guard so this file is never silently a no-op: it asserts the smoke
// is correctly gated off whenever the opt-in switch is absent.
describe("NGX-372 real read smoke gating", () => {
  it("stays opt-in: no run plan without the explicit opt-in switch", () => {
    const offPlan = planLinearReadSmoke({
      [REAL_SMOKE_LINEAR_OPT_IN_ENV_VAR]: undefined,
      LINEAR_API_KEY: "lin_api_present",
    });
    expect(offPlan.mode).toBe("skip");
    if (offPlan.mode !== "skip") throw new Error("expected skip");
    expect(offPlan.reason).toBe("not_opted_in");
  });
});
