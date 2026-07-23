import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import { listEvidenceRecords } from "../src/core/evidence/records.js";
import {
  buildCli,
  cleanupTempRoots,
  makeTempDir,
  runCliBinary,
  runCliBinaryAsync,
} from "./helpers/smoke-harness.js";

beforeAll(buildCli, 60_000);
afterEach(cleanupTempRoots);

function writeLedger(filePath: string, runId: string, step: string): void {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      runId,
      step,
      status: "complete",
      ts: "2026-07-23T00:00:00Z",
    })}\n`,
  );
}

describe("evidence alias concurrency", () => {
  it("keeps mixed legacy and canonical imports idempotent across processes", async () => {
    const dataDir = makeTempDir("momentum-evidence-concurrency-data-");
    const artifactDir = makeTempDir("momentum-evidence-concurrency-artifacts-");
    const runId = "cwfp-concurrent-alias";
    const canonicalDir = path.join(artifactDir, "canonical");
    const legacyDir = path.join(artifactDir, "legacy");
    fs.mkdirSync(canonicalDir);
    fs.mkdirSync(legacyDir);
    const canonicalLedger = path.join(canonicalDir, "ledger.jsonl");
    const legacyLedger = path.join(legacyDir, "ledger.jsonl");
    writeLedger(canonicalLedger, runId, "validate");
    writeLedger(legacyLedger, runId, "no-mistakes");

    const warmup = runCliBinary(["doctor", "--data-dir", dataDir, "--json"]);
    expect(warmup.code).toBe(0);

    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        runCliBinaryAsync([
          "evidence",
          "ingest",
          "--path",
          index % 2 === 0 ? canonicalLedger : legacyLedger,
          "--data-dir",
          dataDir,
          "--json",
        ]),
      ),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);

    const db = openDb(dataDir);
    try {
      const lifecycleRecords = listEvidenceRecords(db, {}).filter(
        (record) =>
          record.runId === runId &&
          (record.stepId === "validate" || record.stepId === "no-mistakes"),
      );
      expect(lifecycleRecords).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
