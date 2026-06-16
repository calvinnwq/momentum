import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("M7 closeout contract (NGX-312, NGX-319)", () => {
  describe("internal/milestones/m7-openclaw-coding-workflow-backend.md", () => {
    const milestonePath = "internal/milestones/m7-openclaw-coding-workflow-backend.md";
    const m7 = readDoc(milestonePath);

    it("pins M7 as closed out at NGX-319 without leaving an in-flight status", () => {
      expect(m7).toMatch(/Status:[^\n]*(Closed out|Complete)/i);
      expect(m7).toMatch(/NGX-319/);
      expect(m7, "M7 milestone doc should not still claim active / in flight").not.toMatch(
        /Status:[^\n]*Active\s*\/\s*in flight/i
      );
    });

    it("states Momentum is the durable run substrate for OpenClaw coding workflows, not a replacement for the executors", () => {
      expect(m7).toMatch(/durable run substrate for OpenClaw coding workflows/i);
      expect(m7).toMatch(/does\s*\*?\*?not\*?\*?\s*replace/i);
      for (const executor of [
        "gnhf-runner",
        "gnhf-postflight",
        "harness-delegate",
        "no-mistakes-pipeline",
        "model-evidence",
        "project-progress-refresh",
      ]) {
        expect(m7, `M7 milestone doc should name ${executor} as an executor owned by the skill, not Momentum`).toContain(executor);
      }
    });

    it("defines the M7 data ownership boundary (run, steps, approvals, leases, evidence pointers, recovery flag)", () => {
      for (const surface of [
        "WorkflowRun",
        "workflow_steps",
        "workflow_approvals",
        "workflow_leases",
        "evidence",
        "needs_manual_recovery",
      ]) {
        expect(m7, `M7 milestone doc should describe ownership of ${surface}`).toContain(surface);
      }
    });

    it("enumerates the canonical step names and approval boundaries (compatibility with the skill)", () => {
      for (const stepName of [
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes",
        "merge-cleanup",
        "linear-refresh",
      ]) {
        expect(m7, `M7 milestone doc should list the ${stepName} step name`).toContain(stepName);
      }
      for (const boundary of [
        "through-implementation",
        "through-no-mistakes",
        "through-merge-cleanup",
        "full",
      ]) {
        expect(m7, `M7 milestone doc should list the ${boundary} approval boundary`).toContain(boundary);
      }
    });

    it("documents the existing repo-local artifacts M7 must stay compatible with", () => {
      for (const artifact of [
        ".agent-workflows/",
        "plan.json",
        "ledger.jsonl",
        "approval-",
        "monitor.json",
      ]) {
        expect(m7, `M7 milestone doc should mention compatibility with ${artifact}`).toContain(artifact);
      }
    });

    it("enumerates the old monitor failure modes M7 eliminates", () => {
      for (const phrase of [
        /in-memory shell session/i,
        /phase-suffixed cron/i,
        /lost managed child/i,
        /monitor lease path/i,
        /approval reconstruction/i,
      ]) {
        expect(m7, `M7 milestone doc should describe failure mode matching ${phrase}`).toMatch(phrase);
      }
    });

    it("records explicit M7 non-goals", () => {
      for (const nonGoal of [
        /Dashboard or UI surface/i,
        /Inbound webhooks/i,
        /Autonomous or background external writes/i,
        /Replacing the GNHF/i,
        /Parallel same-repo Goals|Per-source-item worktrees/i,
        /Strong sandboxing/i,
        /Remote git operations/i,
      ]) {
        expect(m7, `M7 milestone doc should list non-goal matching ${nonGoal}`).toMatch(nonGoal);
      }
    });

    it("lists every M7 implementation issue (NGX-312 through NGX-319) as done", () => {
      for (const issue of [
        "NGX-312",
        "NGX-313",
        "NGX-314",
        "NGX-315",
        "NGX-316",
        "NGX-317",
        "NGX-318",
        "NGX-319",
      ]) {
        expect(m7, `M7 milestone doc should list ${issue}`).toContain(issue);
      }
      expect(m7).toMatch(/M7-00/);
      expect(m7).toMatch(/M7-07/);
    });

    it("documents the closeout marker policy (doctor string is the M7 closeout marker)", () => {
      expect(m7).toMatch(
        /Milestone 7: openclaw coding workflow backend \(NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319\) complete/
      );
    });
  });

  describe("internal/contracts/workflow-runs.md", () => {
    const contract = readDoc("internal/contracts/workflow-runs.md");

    it("pins the contract as complete at NGX-319", () => {
      expect(contract).toMatch(/Status:[^\n]*M7 contract[^\n]*complete/i);
      expect(contract).toContain("NGX-319");
    });

    it("enumerates the durable substrate primitives", () => {
      for (const surface of [
        "WorkflowRun",
        "workflow_steps",
        "workflow_approvals",
        "workflow_leases",
        "evidence_records",
      ]) {
        expect(contract, `M7 contract should describe ${surface}`).toContain(surface);
      }
    });

    it("draws the ownership boundary between Momentum and coding-workflow-pipeline", () => {
      expect(contract).toMatch(/coding-workflow-pipeline/);
      expect(contract).toMatch(/SKILL\.md|skill scripts|skill's/i);
      expect(contract).toMatch(/Momentum (never|does not) schedule[s]? cron|Momentum never renders Discord/i);
    });

    it("composes with prior M3 / M4 / M5 / M6 contracts without renaming them", () => {
      for (const surface of [
        "daemon_runs",
        "repo_locks",
        "RunnerAdapter",
        "MOMENTUM.md",
        "source_items",
        "update_intents",
        "intent apply --external-apply",
      ]) {
        expect(contract, `M7 contract should compose with ${surface}`).toContain(surface);
      }
    });
  });

  describe("internal/roadmap.md", () => {
    const roadmap = readDoc("internal/roadmap.md");

    it("lists M7 as complete in the timeline table", () => {
      expect(roadmap).toMatch(
        /\|\s*Milestone 7\s*\|\s*OpenClaw Coding Workflow Backend\s*\|\s*Complete\s*\|/
      );
    });

    it("links the M7 milestone and contract docs", () => {
      expect(roadmap).toContain("milestones/m7-openclaw-coding-workflow-backend.md");
      expect(roadmap).toContain("contracts/workflow-runs.md");
    });

    it("advances the doctor marker to the M7 closeout string", () => {
      expect(roadmap).toContain(
        "Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete"
      );
      expect(roadmap, "roadmap should not still claim M6 is the doctor marker").not.toMatch(
        /currently reads `Milestone 6: policy-gated external apply/
      );
    });
  });

  describe("AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");

    it("keeps M7 in the narrative as a prior closed milestone", () => {
      expect(agents).toMatch(/Milestone 7\b/);
      expect(agents).toMatch(/M7\b/);
    });

    it("points to the M7 internal milestone and contract docs", () => {
      expect(agents).toContain("internal/milestones/m7-openclaw-coding-workflow-backend.md");
      expect(agents).toContain("internal/contracts/workflow-runs.md");
    });

    it("records the M7 closeout marker as the doctor milestone string", () => {
      expect(agents).toContain(
        "Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete"
      );
    });
  });

  describe("doctor milestone marker (M7 closeout superseded by M8)", () => {
    it("the cli no longer pins the M7 closeout marker after the M8 closeout (NGX-330)", () => {
      const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
      expect(cli).not.toContain(
        "Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete"
      );
      expect(cli).not.toMatch(
        /Milestone 6: policy-gated external apply \(NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302\) complete/
      );
    });
  });

  describe("public docs hygiene (M7 planning stays internal)", () => {
    it("README.md does not leak M7 planning vocabulary", () => {
      const readme = readDoc("README.md");
      expect(readme).not.toMatch(/\bM7\b/);
      expect(readme).not.toMatch(/\bMilestone 7\b/);
      expect(readme).not.toMatch(/WorkflowRun/);
      expect(readme).not.toMatch(/coding-workflow-pipeline/i);
    });

    it("docs/index.md does not link to internal M7 files", () => {
      const docsIndex = readDoc("docs/index.md");
      expect(docsIndex).not.toMatch(/m7-openclaw-coding-workflow-backend/);
      expect(docsIndex).not.toMatch(/workflow-runs\.md/);
    });
  });

  describe("internal/regression-matrix.md (M7 closeout, NGX-319)", () => {
    const matrixPath = "internal/regression-matrix.md";

    it("exists as an internal-only regression matrix doc", () => {
      const full = path.join(repoRoot, matrixPath);
      expect(fs.existsSync(full), `${matrixPath} should exist`).toBe(true);
      const body = fs.readFileSync(full, "utf8");
      expect(body.trim().length, `${matrixPath} should not be empty`).toBeGreaterThan(0);
    });

    it("covers all five old monitor failure modes mandated by NGX-319", () => {
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
          `${matrixPath} should include a row for failure mode "${heading}"`
        ).toContain(heading);
      }
    });

    it("names every monitor-reducer recovery code so each row pins a substrate guard", () => {
      const matrix = readDoc(matrixPath);
      for (const recoveryCode of [
        "stale_running_step",
        "ghost_active_no_lease",
        "manual_recovery_lease",
        "monitor_drift_stale",
        "failed_required_step",
      ]) {
        expect(
          matrix,
          `${matrixPath} should reference the ${recoveryCode} recovery code`
        ).toContain(recoveryCode);
      }
    });

    it("points at the M7 milestone doc, the workflow-runs contract, and the smoke coverage map", () => {
      const matrix = readDoc(matrixPath);
      for (const link of [
        "milestones/m7-openclaw-coding-workflow-backend.md",
        "contracts/workflow-runs.md",
        "smoke-tests.md",
      ]) {
        expect(matrix, `${matrixPath} should link to ${link}`).toContain(link);
      }
    });

    it("references the substrate modules and tests that own each invariant", () => {
      const matrix = readDoc(matrixPath);
      for (const owner of [
        "src/core/workflow/monitor-state.ts",
        "src/core/workflow/run-reducer.ts",
        "src/core/workflow/run-import.ts",
        "src/core/workflow/status.ts",
        "src/core/workflow/handoff.ts",
        "test/workflow-monitor-state.test.ts",
        "test/m7-e2e-smoke.test.ts",
      ]) {
        expect(matrix, `${matrixPath} should cite ${owner} as evidence`).toContain(owner);
      }
    });

    it("names the NGX-318 end-to-end smoke as evidence for the no-ghost-active-run row", () => {
      const matrix = readDoc(matrixPath);
      expect(matrix).toContain("NGX-318");
      expect(matrix).toMatch(/no ghost active run/i);
    });
  });
});
