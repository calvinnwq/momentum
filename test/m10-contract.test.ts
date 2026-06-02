import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

const M10_SLICES = [
  "M10-00",
  "M10-01",
  "M10-02",
  "M10-03",
  "M10-04",
  "M10-05",
  "M10-06",
  "M10-07",
  "M10-08",
  "M10-09",
] as const;

const M10_LINEAR_IDS = [
  "NGX-344",
  "NGX-345",
  "NGX-346",
  "NGX-347",
  "NGX-348",
  "NGX-349",
  "NGX-350",
  "NGX-351",
  "NGX-352",
  "NGX-353",
] as const;

const M8_MARKER =
  "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete";

describe("M10 workflow-first runtime planning contract", () => {
  describe("internal/milestones/m10-workflow-first-runtime.md", () => {
    const milestonePath = "internal/milestones/m10-workflow-first-runtime.md";

    it("exists as the M10 milestone narrative", () => {
      const full = path.join(repoRoot, milestonePath);
      expect(fs.existsSync(full), `${milestonePath} should exist`).toBe(true);
      expect(readDoc(milestonePath).trim().length).toBeGreaterThan(0);
    });

    it("marks M10 as planned / next, not accidentally active or complete", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).toMatch(/Status:[^\n]*Planned\s*\/\s*next/i);
      expect(m10).not.toMatch(/Status:[^\n]*(Active|Complete)/i);
      expect(m10).toMatch(/not active until M10-00\s+lands/i);
    });

    it("pins the workflow-first runtime product shape", () => {
      const m10 = readDoc(milestonePath);

      for (const term of [
        "WorkflowDefinition",
        "WorkflowRun",
        "StepDefinition",
        "StepRun",
        "ExecutorInvocation",
        "ExecutorRound",
        "goal-loop",
      ]) {
        expect(m10, `M10 milestone should name ${term}`).toContain(term);
      }
    });

    it("links the source workflow-first planning contracts", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).toContain("internal/contracts/workflow-first-runtime.md");
      expect(m10).toContain("internal/contracts/executor-loop.md");
      expect(m10).toContain("internal/contracts/workflow-first-gap-matrix.md");
    });

    it("keeps M9 as foundation work instead of rewriting it", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).toMatch(/M9 remains valid foundation work/i);
      expect(m10).toMatch(/live wrapper registry/i);
      expect(m10).toMatch(/verification \/ commit \/ reset finalization/i);
      expect(m10).toMatch(/M10 reuses those primitives/i);
    });

    it("pins the M10-00..M10-09 sequence and assigned NGX issue map", () => {
      const m10 = readDoc(milestonePath);

      for (const slice of M10_SLICES) {
        expect(m10, `M10 milestone should list ${slice}`).toContain(slice);
      }
      for (const issueId of M10_LINEAR_IDS) {
        expect(m10, `M10 milestone should list ${issueId}`).toContain(issueId);
      }
      expect(m10).toMatch(/NGX-345 through NGX-353 are the assigned Linear issue identifiers/i);
    });

    it("keeps the doctor marker pinned to the most recently closed milestone", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).toContain(M8_MARKER);
      expect(m10).toMatch(/M10 planning does not flip it/i);
      expect(m10).toMatch(/M10 may only flip the marker at M10 closeout/i);
    });

    it("records explicit M10 non-goals", () => {
      const m10 = readDoc(milestonePath);

      for (const nonGoal of [
        /Replacing GNHF/i,
        /Replacing .* no-mistakes/i,
        /Remote git operations/i,
        /Public UI|dashboard/i,
        /Autonomous external writes/i,
        /Strong sandboxing/i,
        /Inbound webhooks/i,
      ]) {
        expect(m10, `M10 milestone should list non-goal ${nonGoal}`).toMatch(nonGoal);
      }
    });
  });

  describe("internal/roadmap.md", () => {
    const roadmap = "internal/roadmap.md";

    it("marks M10 as planned / next in the timeline", () => {
      const r = readDoc(roadmap);

      expect(r).toMatch(
        /\|\s*Milestone 10\s*\|\s*Workflow-First Runtime\s*\|\s*Planned\s*\/\s*next\s*\|/
      );
      expect(r).toContain("milestones/m10-workflow-first-runtime.md");
    });

    it("pins the planned M10 sequence while keeping M9 active", () => {
      const r = readDoc(roadmap);

      expect(r).toMatch(/Milestone 9\s*\|\s*Live Workflow Execution\s*\|\s*Active \/ in flight/);
      for (const slice of M10_SLICES) {
        expect(r, `roadmap should list ${slice}`).toContain(slice);
      }
      for (const issueId of M10_LINEAR_IDS) {
        expect(r, `roadmap should list ${issueId}`).toContain(issueId);
      }
    });

    it("keeps the doctor marker on the M8 closeout string", () => {
      expect(readDoc(roadmap)).toContain(M8_MARKER);
    });
  });

  describe("internal/exclusions.md", () => {
    it("states that M10 is planned but workflow-first runtime implementation remains deferred until slices land", () => {
      const e = readDoc("internal/exclusions.md");

      expect(e).toMatch(/Milestone 10 is planned \/ next/i);
      expect(e).toContain("internal/milestones/m10-workflow-first-runtime.md");
      expect(e).toMatch(/deferred until the relevant M10 implementation slices land/i);
    });
  });

  describe("public docs hygiene", () => {
    it("README.md does not expose internal M10 planning vocabulary", () => {
      expect(readDoc("README.md")).not.toMatch(/\bM10\b|Workflow-First Runtime/);
    });

    it("docs/index.md does not link to internal M10 planning files", () => {
      expect(readDoc("docs/index.md")).not.toMatch(/m10-workflow-first-runtime|workflow-first-gap-matrix/);
    });
  });
});
