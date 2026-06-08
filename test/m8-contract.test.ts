import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

const M8_ISSUES = [
  "NGX-323",
  "NGX-324",
  "NGX-325",
  "NGX-326",
  "NGX-327",
  "NGX-328",
  "NGX-329",
  "NGX-330",
] as const;

const M8_SLICES = [
  "M8-00",
  "M8-01",
  "M8-02",
  "M8-03",
  "M8-04",
  "M8-05",
  "M8-06",
  "M8-07",
] as const;

const M8_CLI_ENVELOPES = [
  "workflow run list",
  "workflow run approve",
  "workflow run update-step",
  "workflow run monitor",
] as const;

const M8_REFUSAL_CODES = [
  "unknown_workflow_subcommand",
  "invalid_filter",
  "run_id_required",
  "run_not_found",
] as const;

describe("M8 contract (NGX-323)", () => {
  describe("internal/milestones/m8-workflow-run-operator-controls.md", () => {
    const milestonePath = "internal/milestones/m8-workflow-run-operator-controls.md";

    it("exists as the M8 milestone narrative", () => {
      const full = path.join(repoRoot, milestonePath);
      expect(fs.existsSync(full), `${milestonePath} should exist`).toBe(true);
      const body = fs.readFileSync(full, "utf8");
      expect(body.trim().length, `${milestonePath} should not be empty`).toBeGreaterThan(0);
    });

    it("names M8 as Workflow Run Operator Controls and marks it closed out at NGX-330 (M8-07 closeout slice)", () => {
      const m8 = readDoc(milestonePath);
      expect(m8).toMatch(/Milestone 8/);
      expect(m8).toMatch(/Workflow Run Operator Controls/i);
      expect(m8).toMatch(/Status:[^\n]*(Complete|Closed out)/i);
      expect(m8).toContain("NGX-330");
    });

    it("lists every M8 issue (NGX-323 through NGX-330) and the M8-00 through M8-07 sequencing labels", () => {
      const m8 = readDoc(milestonePath);
      for (const issue of M8_ISSUES) {
        expect(m8, `M8 milestone doc should list ${issue}`).toContain(issue);
      }
      for (const slice of M8_SLICES) {
        expect(m8, `M8 milestone doc should list the ${slice} sequencing label`).toContain(slice);
      }
    });

    it("documents the operator-control CLI envelopes M8 adds (without renaming M7 surfaces)", () => {
      const m8 = readDoc(milestonePath);
      for (const envelope of M8_CLI_ENVELOPES) {
        expect(m8, `M8 milestone doc should name the ${envelope} envelope`).toContain(envelope);
      }
      for (const m7Surface of ["workflow import", "workflow status", "workflow handoff"]) {
        expect(
          m8,
          `M8 milestone doc should call out the wire-stable M7 ${m7Surface} surface`
        ).toContain(m7Surface);
      }
    });

    it("records explicit M8 non-goals (no live executor wrappers, no Discord, no cron, no external writes)", () => {
      const m8 = readDoc(milestonePath);
      for (const nonGoal of [
        /live\s+(GNHF|executor|wrapper|harness|skill\s+script|coding-workflow)/i,
        /Discord/i,
        /\bcron\b/i,
        /external\s+(write|tracker)/i,
        /Dashboard|UI\s+surface/i,
      ]) {
        expect(m8, `M8 milestone doc should list non-goal matching ${nonGoal}`).toMatch(nonGoal);
      }
    });

    it("preserves the M3-M7 wire-stability story (no rename or reshape of prior surfaces)", () => {
      const m8 = readDoc(milestonePath);
      for (const surface of [
        "daemon_runs",
        "repo_locks",
        "RunnerAdapter",
        "MOMENTUM.md",
        "source_items",
        "update_intents",
        "intent apply --external-apply",
        "workflow_runs",
        "workflow_steps",
        "workflow_approvals",
        "workflow_leases",
      ]) {
        expect(m8, `M8 milestone doc should preserve the wire-stable ${surface} surface`).toContain(
          surface
        );
      }
    });

    it("keeps Discord approval UX, monitor cron, and live executor invocation owned by coding-workflow-pipeline", () => {
      const m8 = readDoc(milestonePath);
      expect(m8).toContain("coding-workflow-pipeline");
      expect(m8).toMatch(/Discord(\s+approval)?\s+(delivery|UX|render)/i);
      expect(m8).toMatch(/monitor\s+cron/i);
      expect(m8).toMatch(/(executor invocation|live executor wrappers|live wrappers)/i);
    });

    it("explicitly defers live executor wrappers to a later milestone unless a future decision gate changes that boundary", () => {
      const m8 = readDoc(milestonePath);
      expect(m8).toMatch(/defer(red|s)?[^.]{0,80}(live|wrappers)/i);
      expect(m8).toMatch(/(decision gate|future milestone|later milestone|future explicit decision)/i);
    });

    it("flips the doctor marker to the M8 closeout string (NGX-330 closeout slice)", () => {
      const m8 = readDoc(milestonePath);
      expect(m8).toContain(
        "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete"
      );
    });
  });

  describe("internal/contracts/workflow-operator-controls.md", () => {
    const contractPath = "internal/contracts/workflow-operator-controls.md";

    it("exists as the M8 operator-control cross-milestone contract", () => {
      const full = path.join(repoRoot, contractPath);
      expect(fs.existsSync(full), `${contractPath} should exist`).toBe(true);
      const body = fs.readFileSync(full, "utf8");
      expect(body.trim().length, `${contractPath} should not be empty`).toBeGreaterThan(0);
    });

    it("pins NGX-323 as the contract setup slice and is marked complete at M8 closeout (NGX-330)", () => {
      const c = readDoc(contractPath);
      expect(c).toContain("NGX-323");
      expect(c).toContain("NGX-330");
      expect(c).toMatch(/Status:[^\n]*(M8|Milestone 8)[^\n]*complete/i);
    });

    it("enumerates the M8 operator-control CLI envelopes and the M7 read-only surfaces they compose with", () => {
      const c = readDoc(contractPath);
      for (const envelope of M8_CLI_ENVELOPES) {
        expect(c, `M8 contract should pin the ${envelope} envelope name`).toContain(envelope);
      }
      for (const m7Surface of ["workflow import", "workflow status", "workflow handoff"]) {
        expect(
          c,
          `M8 contract should describe how the ${m7Surface} surface remains wire-stable`
        ).toContain(m7Surface);
      }
    });

    it("pins the stable refusal taxonomy reused by the M8 operator-control surfaces", () => {
      const c = readDoc(contractPath);
      for (const code of M8_REFUSAL_CODES) {
        expect(c, `M8 contract should pin the ${code} refusal code`).toContain(code);
      }
    });

    it("documents the per-run recovery artifact and durable needs_manual_recovery flag (NGX-327)", () => {
      const c = readDoc(contractPath);
      expect(c).toMatch(/recovery\.md/);
      expect(c).toMatch(/needs_manual_recovery/);
      expect(c).toMatch(/NGX-327/);
    });

    it("documents the typed runId / stepId evidence linkage extension (NGX-329) without reshaping M5 evidence_records", () => {
      const c = readDoc(contractPath);
      expect(c).toMatch(/evidence_records/);
      expect(c).toMatch(/runId/);
      expect(c).toMatch(/stepId/);
      expect(c).toMatch(/NGX-329/);
    });

    it("keeps Discord delivery, monitor cron scheduling, and live executor invocation owned by coding-workflow-pipeline", () => {
      const c = readDoc(contractPath);
      expect(c).toMatch(/coding-workflow-pipeline/);
      expect(c).toMatch(/Discord/i);
      expect(c).toMatch(/\bcron\b/i);
      expect(c).toMatch(/Momentum (never|does not) (schedule|render|dispatch|invoke)/i);
    });

    it("explicitly defers live executor wrappers to a later milestone and requires an explicit decision gate to change that boundary", () => {
      const c = readDoc(contractPath);
      expect(c).toMatch(/defer/i);
      expect(c).toMatch(/live\s+(executor|wrapper)/i);
      expect(c).toMatch(/(decision gate|future milestone|explicit decision)/i);
    });

    it("composes with the M3 / M4 / M5 / M6 / M7 contracts without renaming or reshaping them", () => {
      const c = readDoc(contractPath);
      for (const surface of [
        "daemon_runs",
        "repo_locks",
        "RunnerAdapter",
        "MOMENTUM.md",
        "source_items",
        "update_intents",
        "intent apply --external-apply",
        "workflow_runs",
        "workflow_steps",
        "workflow_approvals",
        "workflow_leases",
      ]) {
        expect(c, `M8 contract should compose with ${surface}`).toContain(surface);
      }
    });

    it("links back to the M7 milestone, the M7 workflow-runs contract, and the regression matrix", () => {
      const c = readDoc(contractPath);
      for (const link of [
        "milestones/m7-openclaw-coding-workflow-backend.md",
        "workflow-runs.md",
        "regression-matrix.md",
      ]) {
        expect(c, `M8 contract should link to ${link}`).toContain(link);
      }
    });
  });

  describe("internal/roadmap.md", () => {
    const roadmap = "internal/roadmap.md";

    it("lists M8 as complete in the timeline table", () => {
      const r = readDoc(roadmap);
      expect(r).toMatch(
        /\|\s*Milestone 8\s*\|\s*Workflow Run Operator Controls\s*\|\s*Complete\s*\|/
      );
      expect(r).toContain("milestones/m8-workflow-run-operator-controls.md");
    });

    it("keeps M7 listed as complete in the timeline table", () => {
      const r = readDoc(roadmap);
      expect(r).toMatch(
        /\|\s*Milestone 7\s*\|\s*OpenClaw Coding Workflow Backend\s*\|\s*Complete\s*\|/
      );
    });

    it("records the M8 closeout string in the M8 milestone history", () => {
      const m8 = readDoc("internal/milestones/m8-workflow-run-operator-controls.md");
      expect(m8).toContain(
        "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete"
      );
    });

    it("references every planned M8 issue (NGX-323 through NGX-330) in sequence", () => {
      const r = readDoc(roadmap);
      for (const issue of M8_ISSUES) {
        expect(r, `roadmap should reference ${issue}`).toContain(issue);
      }
    });
  });

  describe("AGENTS.md", () => {
    const agentsPath = "AGENTS.md";

    it("names M8 as the most recently closed milestone while keeping the M7 narrative", () => {
      const a = readDoc(agentsPath);
      expect(a).toMatch(/Milestone 8/);
      expect(a).toMatch(/Workflow Run Operator Controls/i);
      expect(a).toMatch(/Milestone 7/);
      expect(a).toMatch(/most recently closed milestone/i);
    });

    it("links the M8 internal milestone narrative and the operator-controls contract", () => {
      const a = readDoc(agentsPath);
      expect(a).toContain("internal/milestones/m8-workflow-run-operator-controls.md");
      expect(a).toContain("internal/contracts/workflow-operator-controls.md");
    });

    it("records the M8 closeout marker as the doctor milestone string", () => {
      const a = readDoc(agentsPath);
      expect(a).toContain(
        "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete"
      );
    });
  });

  describe("public docs hygiene (M8 planning stays internal)", () => {
    it("README.md does not leak M8 planning vocabulary", () => {
      const readme = readDoc("README.md");
      expect(readme).not.toMatch(/\bM8\b/);
      expect(readme).not.toMatch(/\bMilestone 8\b/);
      expect(readme).not.toMatch(/Workflow Run Operator Controls/i);
    });

    it("docs/index.md does not link to internal M8 planning files", () => {
      const docsIndex = readDoc("docs/index.md");
      expect(docsIndex).not.toMatch(/m8-workflow-run-operator-controls/);
      expect(docsIndex).not.toMatch(/workflow-operator-controls\.md/);
    });
  });

  describe("internal/regression-matrix.md M8 operator-control extension (NGX-330)", () => {
    const matrixPath = "internal/regression-matrix.md";

    it("preserves the five M7 monitor failure-mode rows", () => {
      const matrix = readDoc(matrixPath);
      for (const heading of [
        "Stale monitor state",
        "Lost managed task with completed ledger",
        "Terminal external evidence winning over local drift",
        "Blocked stale step",
        "No ghost active run",
      ]) {
        expect(
          matrix,
          `regression matrix should preserve the M7 row "${heading}"`
        ).toContain(heading);
      }
    });

    it("covers the six M8 operator-control failure modes the milestone eliminates", () => {
      const matrix = readDoc(matrixPath);
      for (const heading of [
        "Run inventory by directory scan",
        "Approval reconstruction from prose",
        "Ledger hand-edits to finalize a step",
        "Monitor-tick prose parsing",
        "Recovery state invisible to operators",
        "Path-only evidence inference",
      ]) {
        expect(
          matrix,
          `regression matrix should include an M8 row for "${heading}"`
        ).toContain(heading);
      }
    });

    it("names every M8 operator-control envelope that owns an invariant", () => {
      const matrix = readDoc(matrixPath);
      for (const envelope of [
        "workflow run list",
        "workflow run approve",
        "workflow run update-step",
        "workflow run clear-recovery",
        "workflow run monitor",
      ]) {
        expect(
          matrix,
          `regression matrix should reference the "${envelope}" envelope`
        ).toContain(envelope);
      }
    });

    it("cites the M8 substrate owners plus the durable recovery flag and per-run artifact", () => {
      const matrix = readDoc(matrixPath);
      for (const owner of [
        "src/cli.ts",
        "src/workflow-run-recovery.ts",
        "src/workflow-monitor-envelope.ts",
        "src/workflow-recovery-artifact.ts",
        "src/evidence-workflow.ts",
      ]) {
        expect(matrix, `regression matrix should cite ${owner} as an M8 owner`).toContain(
          owner
        );
      }
      expect(matrix).toContain("needs_manual_recovery");
      expect(matrix).toContain("recovery.md");
    });

    it("names the NGX-330 end-to-end operator-control smoke as M8 evidence", () => {
      const matrix = readDoc(matrixPath);
      expect(matrix).toContain("NGX-330");
      expect(matrix).toContain("Milestone 8 operator-control end-to-end smoke");
      expect(matrix).toMatch(/ghost-active run/i);
    });

    it("links the M8 milestone narrative and the operator-controls contract", () => {
      const matrix = readDoc(matrixPath);
      for (const link of [
        "milestones/m8-workflow-run-operator-controls.md",
        "contracts/workflow-operator-controls.md",
      ]) {
        expect(matrix, `regression matrix should link to ${link}`).toContain(link);
      }
    });

  });

  describe("doctor milestone marker history (M8 closeout at NGX-330)", () => {
    it("the M8 milestone narrative records the M8 marker that was current at NGX-330", () => {
      const milestone = readDoc("internal/milestones/m8-workflow-run-operator-controls.md");
      expect(milestone).toContain(
        "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete"
      );
    });

    it("the current cli no longer reports the M7 marker", () => {
      const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
      expect(cli).not.toContain(
        "Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete"
      );
    });
  });
});
