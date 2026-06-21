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
  "M10-09a",
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
  "NGX-367",
  "NGX-353",
] as const;

const M8_MARKER =
  "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete";
const M10_MARKER =
  "Milestone 10: workflow-first runtime (NGX-344, NGX-345, NGX-346, NGX-347, NGX-348, NGX-349, NGX-350, NGX-351, NGX-352, NGX-367, NGX-353) complete";
const M11_MARKER =
  "Milestone 11: CLI architecture refactor (NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416, NGX-417, NGX-418, NGX-419) complete";

describe("M10 workflow-first runtime planning contract", () => {
  describe("internal/milestones/m10-workflow-first-runtime.md", () => {
    const milestonePath = "internal/milestones/m10-workflow-first-runtime.md";

    it("exists as the M10 milestone narrative", () => {
      const full = path.join(repoRoot, milestonePath);
      expect(fs.existsSync(full), `${milestonePath} should exist`).toBe(true);
      expect(readDoc(milestonePath).trim().length).toBeGreaterThan(0);
    });

    it("marks M10 as complete after the closeout dogfood", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).toMatch(/Status:[^\n]*Complete/i);
      expect(m10).toMatch(/M10-00 promoted/i);
      expect(m10).toMatch(/M10-01 landed/i);
      expect(m10).toMatch(/M10-09 dogfooded/i);
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
      expect(m10).toMatch(/NGX-367 inserted as the M10-09a/i);
    });

    it("records the M10 closeout doctor marker", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).not.toContain(M8_MARKER);
      expect(m10).toContain(M10_MARKER);
      expect(m10).toMatch(/M10 flipped the marker at M10 closeout/i);
    });

    it("records the closeout dogfood evidence and boundary", () => {
      const m10 = readDoc(milestonePath);

      expect(m10).toContain("ngx353-m10-closeout");
      expect(m10).toContain("workflow run start");
      expect(m10).toContain("daemon start --max-loop-iterations 1");
      expect(m10).toMatch(/monitorDrift\.drifted: false/i);
      expect(m10).toMatch(/phase-1 start\s+scaffold/i);
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

    it("marks M10 as complete in the timeline", () => {
      const r = readDoc(roadmap);

      expect(r).toMatch(
        /\|\s*Milestone 10\s*\|\s*Workflow-First Runtime\s*\|\s*Complete\s*\|/
      );
      expect(r).toContain("milestones/m10-workflow-first-runtime.md");
    });

    it("pins the M10 sequence while keeping M9 as foundation", () => {
      const r = readDoc(roadmap);

      expect(r).toMatch(/Milestone 9\s*\|\s*Live Workflow Execution\s*\|\s*Foundation in force/);
      for (const slice of M10_SLICES) {
        expect(r, `roadmap should list ${slice}`).toContain(slice);
      }
      for (const issueId of M10_LINEAR_IDS) {
        expect(r, `roadmap should list ${issueId}`).toContain(issueId);
      }
    });

    it("preserves the M10 marker in history after the M11 closeout advance", () => {
      const r = readDoc(roadmap);
      expect(r).not.toContain(M8_MARKER);
      expect(r).toContain(M10_MARKER);
      expect(r).toContain(M11_MARKER);
    });
  });

  describe("internal/exclusions.md", () => {
    it("states that M10 closeout landed while later runtime behavior narrowed after RC follow-ups", () => {
      const e = readDoc("internal/exclusions.md");

      expect(e).toMatch(/M10 planning pinned/i);
      expect(e).toContain("internal/milestones/m10-workflow-first-runtime.md");
      expect(e).toMatch(/workflow-first\s+dogfood and M10 closeout marker have landed/i);
      expect(e).toMatch(/external-apply[\s\S]*subworkflow[\s\S]*production flip have landed/i);
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
