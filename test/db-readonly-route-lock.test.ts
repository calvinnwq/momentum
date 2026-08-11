import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/db/route-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/adapters/db/route-state.js")>();
  let probeCalls = 0;
  return {
    ...actual,
    routeStateMigrationNeeded: vi.fn((db) => {
      if (probeCalls++ === 0) {
        throw Object.assign(new Error("database is locked"), { errcode: 5 });
      }
      return actual.routeStateMigrationNeeded(db);
    }),
  };
});

import { openExistingDbMigratedReadOnly } from "../src/adapters/db.js";

const tempRoots: string[] = [];
const fixturePath = path.join(__dirname, "fixtures", "v0220-route-state.sql");

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("read-only route-state migration probe", () => {
  it("uses a fully migrated snapshot when the route probe is busy", () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "momentum-readonly-route-probe-"),
    );
    tempRoots.push(dataDir);
    const dbPath = path.join(dataDir, "momentum.db");
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(fs.readFileSync(fixturePath, "utf8"));
    } finally {
      seed.close();
    }

    const db = openExistingDbMigratedReadOnly(dataDir);
    expect(db).toBeDefined();
    try {
      // The snapshot serves the fully migrated shape: the retired route_json
      // column is rebuilt away and the canonical marker tables exist.
      const columns = (
        db!.prepare('PRAGMA table_info("workflow_runs")').all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(columns).not.toContain("route_json");
      expect(
        db!
          .prepare("SELECT 1 FROM workflow_runs WHERE id = 'native-simple'")
          .get(),
      ).toEqual({ 1: 1 });
      expect(
        db!
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get("workflow_run_coding_compatibility"),
      ).toEqual({ 1: 1 });
    } finally {
      db?.close();
    }
  });
});
