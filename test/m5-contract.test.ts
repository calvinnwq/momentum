import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

const M5_ISSUE_ORDER = [
  "NGX-287",
  "NGX-288",
  "NGX-289",
  "NGX-290",
  "NGX-291",
  "NGX-292",
  "NGX-293",
  "NGX-294"
] as const;

const M5_VOCABULARY = [
  "SourceItem",
  "SourceAdapter",
  "source snapshot",
  "reconciliation run",
  "evidence artifact",
  "external update intent",
  "project rollup"
] as const;

const M5_NON_GOALS_README = [
  "Automatic external tracker writes",
  "Inbound webhooks",
  "Dashboard or UI surface",
  "Per-source-item worktrees",
  "Background runner supervision",
  "Strong sandboxing",
  "Cooperative mid-job cancellation / signal handling",
  "Remote git operations"
] as const;

const M5_NON_GOALS_AGENTS = [
  "automatic external tracker writes",
  "inbound webhooks",
  "dashboards / UI surfaces",
  "per-source-item worktrees / parallel same-repo Goals",
  "background runner supervision",
  "strong sandboxing",
  "cooperative mid-job cancellation / signal handling",
  "remote git operations"
] as const;

describe("M5 contract docs (NGX-287 setup)", () => {
  describe("README.md", () => {
    const readme = readDoc("README.md");

    it("names Milestone 5 as the active milestone without claiming completion (NGX-287)", () => {
      expect(readme).toContain("## Milestone 5 Roadmap");
      expect(readme).toMatch(/Milestone 5 \(Source Adapters and Evidence Sync\) is the active milestone/);
      expect(readme).not.toMatch(/Milestone 5 \(Source Adapters and Evidence Sync\) is complete/);
    });

    it("defines the M5 vocabulary explicitly", () => {
      for (const term of M5_VOCABULARY) {
        expect(readme).toContain(term);
      }
    });

    it("states the M5 trust boundary (read-only sources, durable intents, no auto external writes)", () => {
      expect(readme).toContain("M5 trust boundary");
      expect(readme).toMatch(/durable .*intent/i);
      expect(readme).toContain(
        "Momentum does **not** perform automatic external writes in M5"
      );
    });

    it("documents how M5 composes with existing contracts", () => {
      expect(readme).toContain("M5 composition with existing contracts");
      for (const surface of [
        "Goal",
        "Iteration",
        "Job",
        "RunnerAdapter",
        "daemon",
        "recovery",
        "handoff",
        "MOMENTUM.md"
      ]) {
        expect(readme).toContain(surface);
      }
    });

    it("documents the planned M5 issue order matching the Linear milestone", () => {
      expect(readme).toContain("Planned M5 issue order");
      let cursor = -1;
      for (const id of M5_ISSUE_ORDER) {
        const next = readme.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M5 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("calls out explicit M5 non-goals", () => {
      expect(readme).toContain("M5 non-goals");
      for (const ng of M5_NON_GOALS_README) {
        expect(readme).toContain(ng);
      }
    });

    it("preserves the M4 closeout markers and the M4 Roadmap", () => {
      expect(readme).toContain("## Milestone 4 Roadmap");
      expect(readme).toContain("Milestone 4 (Real Runner Profiles) is complete");
      for (const id of [
        "NGX-279",
        "NGX-280",
        "NGX-281",
        "NGX-282",
        "NGX-283",
        "NGX-284",
        "NGX-285",
        "NGX-286"
      ]) {
        expect(readme).toContain(id);
      }
    });

    it("preserves M3 closeout markers and the M3 Alignment narrative", () => {
      expect(readme).toContain("Milestone 3 (Operational Safety) is complete");
      expect(readme).toContain("## Milestone 3 Alignment");
      for (const id of [
        "NGX-272",
        "NGX-273",
        "NGX-274",
        "NGX-275",
        "NGX-276",
        "NGX-277",
        "NGX-278"
      ]) {
        expect(readme).toContain(id);
      }
    });

    it("preserves the M3 CLI surface in command examples", () => {
      for (const cmd of [
        "momentum daemon start",
        "momentum daemon stop",
        "momentum daemon status",
        "momentum recovery clear",
        "momentum doctor"
      ]) {
        expect(readme).toContain(cmd);
      }
    });
  });

  describe("AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");

    it("names Milestone 5 as the active milestone (not complete)", () => {
      expect(agents).toMatch(/Milestone 5: Source Adapters and Evidence Sync is the active milestone/);
      expect(agents).not.toMatch(/Milestone 5: Source Adapters and Evidence Sync is complete/);
    });

    it("documents the M5 contract block with vocabulary, trust boundary, and non-goals", () => {
      expect(agents).toContain("## Milestone 5 contract");
      for (const term of M5_VOCABULARY) {
        expect(agents).toContain(term);
      }
      for (const ng of M5_NON_GOALS_AGENTS) {
        expect(agents).toContain(ng);
      }
    });

    it("documents the planned M5 issue order in the same sequence as README", () => {
      let cursor = -1;
      for (const id of M5_ISSUE_ORDER) {
        const next = agents.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M5 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("preserves the M4 complete bullet verbatim", () => {
      expect(agents).toContain("Milestone 4: Real Runner Profiles is complete");
      for (const id of [
        "NGX-279",
        "NGX-280",
        "NGX-281",
        "NGX-282",
        "NGX-283",
        "NGX-284",
        "NGX-285",
        "NGX-286"
      ]) {
        expect(agents).toContain(id);
      }
    });

    it("preserves the M3 complete bullets verbatim", () => {
      expect(agents).toContain("Milestone 3: Operational Safety is complete");
      for (const id of [
        "NGX-272",
        "NGX-273",
        "NGX-274",
        "NGX-275",
        "NGX-276",
        "NGX-277",
        "NGX-278"
      ]) {
        expect(agents).toContain(id);
      }
    });

    it("preserves the M3 CLI surface bullets", () => {
      for (const cmd of [
        "`daemon start`",
        "`daemon stop`",
        "`daemon status`",
        "`recovery clear`",
        "`doctor`"
      ]) {
        expect(agents).toContain(cmd);
      }
    });
  });

  it("keeps the doctor milestone string pinned to the M4 closeout marker until M5 closeout intentionally flips it", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).toContain(
      "Milestone 4: real runner profiles (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286) complete"
    );
    expect(cli).not.toMatch(
      /Milestone 5: source adapters and evidence sync .* complete/i
    );
  });
});
