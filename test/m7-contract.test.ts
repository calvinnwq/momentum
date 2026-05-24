import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("M7 active-marker contract (NGX-312)", () => {
  describe("internal/milestones/m7-openclaw-coding-workflow-backend.md", () => {
    const milestonePath = "internal/milestones/m7-openclaw-coding-workflow-backend.md";
    const m7 = readDoc(milestonePath);

    it("pins M7 as active / planned without claiming complete", () => {
      expect(m7).toMatch(/Status:[^\n]*Active\s*\/\s*planned/i);
      const forbiddenClaims = [
        /Milestone 7[^.\n]*\bis complete\b/i,
        /\bM7\b[^.\n]*\bis complete\b/i,
        /Status:[^.\n]*\bComplete\b/i,
      ];
      for (const re of forbiddenClaims) {
        expect(m7, `M7 milestone doc should not claim complete via ${re}`).not.toMatch(re);
      }
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

    it("lists NGX-312 as M7-00 and does not claim later M7 implementation slices as done", () => {
      expect(m7).toContain("NGX-312");
      expect(m7).toMatch(/M7-00/);
      expect(m7).not.toMatch(/NGX-3\d{2}[^\n]*\*\(done\)\*/);
    });

    it("documents the closeout marker policy (doctor string stays at M6 until M7 closeout)", () => {
      expect(m7).toMatch(/doctor[^\n]*M6 closeout marker|M6 closeout marker|stays at the M6 closeout/i);
    });
  });

  describe("internal/contracts/workflow-runs.md", () => {
    const contract = readDoc("internal/contracts/workflow-runs.md");

    it("pins the contract as planned, not complete", () => {
      expect(contract).toMatch(/Status:[^\n]*M7 contract[^\n]*\(planned\)/i);
      expect(contract).not.toMatch(/Status:[^.\n]*\bComplete\b/i);
      expect(contract).not.toMatch(/Milestone 7[^.\n]*\bis complete\b/i);
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

    it("lists M7 as active / planned in the timeline table", () => {
      expect(roadmap).toMatch(/Milestone 7[^\n]*OpenClaw Coding Workflow Backend[^\n]*Active\s*\/\s*planned/i);
    });

    it("links the M7 milestone and contract docs", () => {
      expect(roadmap).toContain("milestones/m7-openclaw-coding-workflow-backend.md");
      expect(roadmap).toContain("contracts/workflow-runs.md");
    });

    it("keeps the doctor marker at the M6 closeout string while M7 is active", () => {
      expect(roadmap).toContain(
        "Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete"
      );
      expect(roadmap).not.toMatch(/\| Milestone 7 \|[^|]*\|\s*Complete\s*\|/i);
      expect(roadmap).not.toMatch(/Milestone 7[^\n]* is complete\b/i);
    });
  });

  describe("AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");

    it("names M7 as the active planning milestone", () => {
      expect(agents).toMatch(/Milestone 7\b/);
      expect(agents).toMatch(/M7\b/);
      expect(agents).toMatch(/active planning milestone/i);
    });

    it("points to the M7 internal milestone and contract docs", () => {
      expect(agents).toContain("internal/milestones/m7-openclaw-coding-workflow-backend.md");
      expect(agents).toContain("internal/contracts/workflow-runs.md");
    });

    it("does not claim M7 is complete", () => {
      const forbiddenClaims = [
        /Milestone 7[^.\n]*\bis complete\b/i,
        /\bM7\b[^.\n]*\bis complete\b/i,
        /Milestone 7 closeout marker/i,
        /M7 closeout marker is/i,
      ];
      for (const re of forbiddenClaims) {
        expect(agents, `AGENTS.md should not claim complete via ${re}`).not.toMatch(re);
      }
    });
  });

  describe("doctor milestone marker (still M6 until M7 closeout)", () => {
    it("the cli still reports the M6 closeout marker, not an M7 marker", () => {
      const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
      expect(cli).toContain(
        "Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete"
      );
      expect(cli).not.toMatch(/Milestone 7[^\n]*complete/i);
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
});
