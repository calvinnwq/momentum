import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

function sectionBetween(doc: string, start: string, end: string): string {
  const startIndex = doc.indexOf(start);
  expect(startIndex, `${start} section should exist`).toBeGreaterThanOrEqual(0);

  const endIndex = doc.indexOf(end, startIndex + start.length);
  expect(endIndex, `${end} section should exist after ${start}`).toBeGreaterThan(startIndex);

  return doc.slice(startIndex, endIndex);
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

const M5_NON_GOALS_DOC = [
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

const M5_DOC_PATH = path.join("internal", "milestones", "m5-source-adapters.md");

describe("M5 contract docs (NGX-287 setup, NGX-294 closeout)", () => {
  describe("README.md", () => {
    const readme = readDoc("README.md");

    it("keeps milestone closeout detail out of the concise OSS front door", () => {
      expect(readme).not.toMatch(/Milestone 5 \(Source Adapters and Evidence Sync\) is complete/);
      expect(readme).not.toMatch(/Milestone 5 \(Source Adapters and Evidence Sync\) is the active milestone/);
      for (const id of M5_ISSUE_ORDER) {
        expect(readme).not.toContain(id);
      }
    });

    it("keeps prior M4 closeout detail out of README", () => {
      expect(readme).not.toContain("## Milestone 4 Roadmap");
      expect(readme).not.toContain("Milestone 4 (Real Runner Profiles) is complete");
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
        expect(readme).not.toContain(id);
      }
    });

    it("keeps prior M3 closeout detail out of README", () => {
      expect(readme).not.toContain("Milestone 3 (Operational Safety) is complete");
      expect(readme).not.toContain("## Milestone 3 Alignment");
      for (const id of [
        "NGX-272",
        "NGX-273",
        "NGX-274",
        "NGX-275",
        "NGX-276",
        "NGX-277",
        "NGX-278"
      ]) {
        expect(readme).not.toContain(id);
      }
    });

    it("preserves the M3 CLI surface in the compact command overview", () => {
      for (const cmd of [
        "momentum daemon start",
        "stop",
        "status",
        "momentum recovery clear",
        "momentum doctor"
      ]) {
        expect(readme).toContain(cmd);
      }
    });
  });

  describe("docs/index.md", () => {
    const docsIndex = readDoc("docs/index.md");

    it("keeps the internal M5 docs page out of the public docs index", () => {
      expect(docsIndex).not.toMatch(/milestones\/m5-source-adapters\.md/);
    });
  });

  describe("internal/milestones/m5-source-adapters.md", () => {
    const m5doc = readDoc(M5_DOC_PATH);

    it("names M5 complete with the NGX-287..NGX-294 closeout", () => {
      expect(m5doc).toMatch(/Complete \(NGX-287 through NGX-294\)/);
    });

    it("defines the M5 vocabulary explicitly", () => {
      expect(m5doc).toContain("## M5 vocabulary");
      for (const term of M5_VOCABULARY) {
        expect(m5doc).toContain(term);
      }
    });

    it("states the M5 trust boundary (read-only sources, durable intents, no auto external writes)", () => {
      expect(m5doc).toContain("## M5 trust boundary");
      expect(m5doc).toMatch(/durable .*intent/i);
      expect(m5doc).toContain(
        "Momentum does **not** perform automatic external writes in M5"
      );
    });

    it("documents how M5 composes with existing contracts", () => {
      expect(m5doc).toContain("## M5 composition with existing contracts");
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
        expect(m5doc).toContain(surface);
      }
    });

    it("documents the planned M5 issue order matching the Linear milestone", () => {
      expect(m5doc).toContain("## Planned M5 issue order");
      const plannedOrder = sectionBetween(
        m5doc,
        "## Planned M5 issue order",
        "## M5 non-goals (explicit)"
      );
      let cursor = -1;
      for (const id of M5_ISSUE_ORDER) {
        const next = plannedOrder.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M5 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("calls out explicit M5 non-goals", () => {
      expect(m5doc).toContain("## M5 non-goals (explicit)");
      for (const ng of M5_NON_GOALS_DOC) {
        expect(m5doc).toContain(ng);
      }
    });

    it("preserves M3 and M4 contracts through M5", () => {
      expect(m5doc).toContain("## M3 and M4 contracts preserved");
      for (const cmd of [
        "daemon start",
        "daemon stop",
        "daemon status",
        "recovery clear"
      ]) {
        expect(m5doc).toContain(cmd);
      }
      for (const profile of ["fake", "trusted-shell", "acp"]) {
        expect(m5doc).toContain(profile);
      }
    });
  });

  describe("AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");

    it("points agents to the internal M5 planning page instead of duplicating it", () => {
      expect(agents).toContain("internal/milestones/");
      expect(agents).toContain("m5-source-adapters.md");
      for (const id of M5_ISSUE_ORDER) {
        expect(agents).not.toContain(id);
      }
      expect(agents).not.toMatch(/Milestone 5: Source Adapters and Evidence Sync is the active milestone/);
    });

    it("keeps old M5 contract prose out of AGENTS.md", () => {
      expect(agents).not.toContain("## Milestone 5 contract");
      expect(agents).not.toContain("Planned M5 issue order");
    });

    it("keeps planned M5 issue order in internal docs only", () => {
      for (const id of M5_ISSUE_ORDER) {
        expect(agents).not.toContain(id);
      }
    });

    it("keeps old M4 complete bullets out of AGENTS.md", () => {
      expect(agents).not.toContain("Milestone 4: Real Runner Profiles is complete");
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
        expect(agents).not.toContain(id);
      }
    });

    it("keeps old M3 complete bullets out of AGENTS.md", () => {
      expect(agents).not.toContain("Milestone 3: Operational Safety is complete");
      for (const id of [
        "NGX-272",
        "NGX-273",
        "NGX-274",
        "NGX-275",
        "NGX-276",
        "NGX-277",
        "NGX-278"
      ]) {
        expect(agents).not.toContain(id);
      }
    });

    it("preserves the M3 CLI surface compactly", () => {
      for (const cmd of [
        "daemon start",
        "daemon stop",
        "daemon status",
        "recovery clear",
        "doctor"
      ]) {
        expect(agents).toContain(cmd);
      }
    });
  });

  it("keeps the doctor milestone string moved off the M4 closeout marker after the M5 closeout (NGX-294)", () => {
    // NGX-302 (M6-07) intentionally flipped the doctor marker forward from M5 to M6;
    // this test continues to assert the M4 closeout marker is no longer pinned, mirroring
    // NGX-294's original intent of preserving the post-flip invariant.
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toContain(
      "Milestone 4: real runner profiles (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286) complete"
    );
  });
});
