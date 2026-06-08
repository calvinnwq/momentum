import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

// M9-00 (NGX-331) is the contract / decision-gate slice that promotes the M9
// draft into the active milestone. It pins the full implementation sequence,
// the chosen live-wrapper architecture, the non-goals, and the doctor-marker
// policy. It must NOT change runtime behavior: the doctor marker stays on the
// M8 closeout string until the M9 closeout slice (NGX-338).

const M9_ISSUES = [
  "NGX-331",
  "NGX-332",
  "NGX-333",
  "NGX-334",
  "NGX-335",
  "NGX-336",
  "NGX-337",
  "NGX-338",
] as const;

const M9_SLICES = [
  "M9-00",
  "M9-01",
  "M9-02",
  "M9-03",
  "M9-04",
  "M9-05",
  "M9-06",
  "M9-07",
] as const;

const M9_STEP_KINDS = [
  "preflight",
  "implementation",
  "postflight",
  "no-mistakes",
  "merge-cleanup",
  "linear-refresh",
] as const;

const M9_WRAPPER_CONFIG_KEYS = [
  "command",
  "args",
  "cwd",
  "timeoutSec",
  "envAllow",
  "resultFile",
  "probe",
] as const;

const M9_RECOVERY_CODES = [
  "runtime_unavailable",
  "auth_unavailable",
  "command_failed",
  "command_timed_out",
  "result_missing",
  "result_invalid",
  "output_overflow",
  "stale_live_step",
  "head_mismatch",
  "manual_recovery_required",
] as const;

const M8_MARKER =
  "Milestone 8: workflow run operator controls (NGX-323, NGX-324, NGX-325, NGX-326, NGX-327, NGX-328, NGX-329, NGX-330) complete";

describe("M9 contract decision gate (NGX-331)", () => {
  describe("internal/milestones/m9-live-workflow-execution.md", () => {
    const milestonePath = "internal/milestones/m9-live-workflow-execution.md";

    it("exists as the M9 milestone narrative", () => {
      const full = path.join(repoRoot, milestonePath);
      expect(fs.existsSync(full), `${milestonePath} should exist`).toBe(true);
      const body = fs.readFileSync(full, "utf8");
      expect(body.trim().length, `${milestonePath} should not be empty`).toBeGreaterThan(0);
    });

    it("promotes M9 from draft into the active milestone at the M9-00 decision gate (NGX-331)", () => {
      const m9 = readDoc(milestonePath);
      expect(m9, "M9 milestone doc should mark an active / in-flight status").toMatch(
        /Status:[^\n]*(Active|In flight|In progress|Promoted)/i
      );
      expect(
        m9,
        "M9 milestone doc should no longer claim Draft / candidate status"
      ).not.toMatch(/Status:[^\n]*Draft\s*\/\s*candidate/i);
      expect(m9).toContain("NGX-331");
      expect(m9).toMatch(/M9-00/);
    });

    it("names M9 as Live Workflow Execution that wraps (does not rewrite) the existing engines", () => {
      const m9 = readDoc(milestonePath);
      expect(m9).toMatch(/Milestone 9/);
      expect(m9).toMatch(/Live Workflow Execution/i);
      expect(m9).toMatch(/wraps existing engines/i);
      expect(m9).toMatch(/does not (rewrite|replace)/i);
    });

    it("pins the full M9 implementation sequence NGX-331..NGX-338 against M9-00..M9-07", () => {
      const m9 = readDoc(milestonePath);
      for (const issue of M9_ISSUES) {
        expect(m9, `M9 milestone doc should list ${issue}`).toContain(issue);
      }
      for (const slice of M9_SLICES) {
        expect(m9, `M9 milestone doc should list the ${slice} sequencing label`).toContain(slice);
      }
      expect(
        m9,
        "M9 milestone doc should no longer leave issue IDs intentionally unassigned"
      ).not.toMatch(/intentionally not assigned/i);
    });

    it("pins the chosen live-wrapper architecture (registry keyed by WorkflowStepKind, explicit argv, durable config, probe)", () => {
      const m9 = readDoc(milestonePath);
      expect(m9).toMatch(/WorkflowStepKind/);
      expect(m9).toMatch(/registry/i);
      expect(m9).toMatch(/argv/i);
      expect(m9).toMatch(/probe/i);
      expect(m9).toMatch(/durable (config|configuration|profile)/i);
      for (const kind of M9_STEP_KINDS) {
        expect(m9, `M9 milestone doc should name the ${kind} step kind`).toContain(kind);
      }
    });

    it("pins the run-start surface decision (reuse goal start + WorkflowRun link over a new verb)", () => {
      const m9 = readDoc(milestonePath);
      expect(m9).toMatch(/goal start/);
      expect(m9).toMatch(/WorkflowRun/);
      expect(m9).toMatch(/workflow run start/);
      expect(m9).toMatch(/(reuse|simpler path|prefer)/i);
    });

    it("records explicit M9 non-goals", () => {
      const m9 = readDoc(milestonePath);
      for (const nonGoal of [
        /Discord/i,
        /\bcron\b/i,
        /Dashboard|web UI|UI surface/i,
        /Strong sandboxing/i,
        /Remote git operations/i,
        /Autonomous .* external writes|Autonomous external writes/i,
        /Parallel same-repo/i,
        /(Replacing|rewrite|rewriting)[^.]*(GNHF|postflight|no-mistakes)/i,
      ]) {
        expect(m9, `M9 milestone doc should list non-goal matching ${nonGoal}`).toMatch(nonGoal);
      }
    });

    it("documents the doctor-marker policy: marker stays on the M8 closeout string until the M9 closeout slice (NGX-338)", () => {
      const m9 = readDoc(milestonePath);
      expect(m9).toContain(M8_MARKER);
      expect(m9).toMatch(/NGX-338/);
      expect(m9).toMatch(/(remains? pinned|stays pinned|does not flip|may not flip|not flip)/i);
    });
  });

  describe("internal/contracts/live-workflow-execution.md", () => {
    const contractPath = "internal/contracts/live-workflow-execution.md";

    it("exists as the M9 cross-milestone contract", () => {
      const full = path.join(repoRoot, contractPath);
      expect(fs.existsSync(full), `${contractPath} should exist`).toBe(true);
      const body = fs.readFileSync(full, "utf8");
      expect(body.trim().length, `${contractPath} should not be empty`).toBeGreaterThan(0);
    });

    it("promotes the contract from draft to active at the M9-00 decision gate (NGX-331)", () => {
      const c = readDoc(contractPath);
      expect(c).toMatch(/Status:[^\n]*(Active|Promoted)/i);
      expect(c, "M9 contract Status line should no longer say Draft").not.toMatch(
        /Status:[^\n]*Draft/i
      );
      expect(c).toContain("NGX-331");
    });

    it("pins the live wrapper registry config keys", () => {
      const c = readDoc(contractPath);
      for (const key of M9_WRAPPER_CONFIG_KEYS) {
        expect(c, `M9 contract should pin the ${key} wrapper config key`).toContain(key);
      }
      expect(c).toMatch(/WorkflowStepKind/);
    });

    it("pins the live-wrapper recovery taxonomy", () => {
      const c = readDoc(contractPath);
      for (const code of M9_RECOVERY_CODES) {
        expect(c, `M9 contract should pin the ${code} recovery code`).toContain(code);
      }
    });

    it("pins the dogfood gate (a real Momentum issue through Momentum-owned live execution)", () => {
      const c = readDoc(contractPath);
      expect(c).toMatch(/dogfood/i);
      expect(c).toMatch(/real Momentum issue/i);
    });

    it("keeps the M9 ownership boundary: wraps the existing OpenClaw engines, does not rewrite them", () => {
      const c = readDoc(contractPath);
      for (const executor of [
        "gnhf-runner",
        "gnhf-postflight",
        "harness-delegate",
        "no-mistakes-pipeline",
        "model-evidence",
        "project-progress-refresh",
      ]) {
        expect(c, `M9 contract should name ${executor} as an engine M9 wraps`).toContain(executor);
      }
      expect(c).toMatch(/wraps existing (executors|engines)/i);
      expect(c).toMatch(/does not (rewrite|replace)/i);
    });

    it("stays compatible with the M3..M8 surfaces without renaming them", () => {
      const c = readDoc(contractPath);
      for (const surface of [
        "RunnerAdapter",
        "trusted-shell",
        "acp",
        "external apply",
        "WorkflowRun",
        "operator-control",
      ]) {
        expect(c, `M9 contract should preserve compatibility with ${surface}`).toContain(surface);
      }
    });
  });

  describe("internal/roadmap.md", () => {
    const roadmap = "internal/roadmap.md";

    it("marks M9 as foundation in force in the timeline table", () => {
      const r = readDoc(roadmap);
      expect(r).toMatch(
        /\|\s*Milestone 9\s*\|\s*Live Workflow Execution\s*\|\s*Foundation in force\s*\|/
      );
    });

    it("links the M9 milestone and contract docs", () => {
      const r = readDoc(roadmap);
      expect(r).toContain("milestones/m9-live-workflow-execution.md");
      expect(r).toContain("contracts/live-workflow-execution.md");
    });

    it("records that the M9 decision gate did not flip the M8 marker", () => {
      const m9 = readDoc("internal/milestones/m9-live-workflow-execution.md");
      expect(m9).toContain(M8_MARKER);
    });

    it("references the M9 implementation sequence NGX-331..NGX-338", () => {
      const r = readDoc(roadmap);
      for (const issue of M9_ISSUES) {
        expect(r, `roadmap should reference ${issue}`).toContain(issue);
      }
    });

    it("keeps M8 listed as complete in the timeline table", () => {
      const r = readDoc(roadmap);
      expect(r).toMatch(
        /\|\s*Milestone 8\s*\|\s*Workflow Run Operator Controls\s*\|\s*Complete\s*\|/
      );
    });
  });

  describe("internal/exclusions.md", () => {
    const exclusions = "internal/exclusions.md";

    it("marks M9 live execution as foundation work rather than a post-M8 deferral", () => {
      const e = readDoc(exclusions);
      expect(e).toMatch(/Milestone 9 \(Live Workflow Execution\)[\s\S]*foundation work/i);
      expect(e).toMatch(/M9 owns[\s\S]*live executor\s+wrappers/);
      expect(e).toContain("NGX-331");
      expect(e).toContain("internal/milestones/m9-live-workflow-execution.md");
      expect(e).toContain("internal/contracts/live-workflow-execution.md");
      expect(e).not.toMatch(/remain deferred past M8 closeout/i);
      expect(e).not.toMatch(/future explicit decision gate/i);
    });
  });

  describe("AGENTS.md", () => {
    const agentsPath = "AGENTS.md";

    it("names M9 as the active milestone promoted at NGX-331 while keeping M8 most recently closed", () => {
      const a = readDoc(agentsPath);
      expect(a).toMatch(/Milestone 9/);
      expect(a).toMatch(/Live Workflow Execution/i);
      expect(a).toContain("NGX-331");
      expect(a).toMatch(/most recently closed milestone/i);
    });

    it("links the M9 milestone narrative and the live-workflow-execution contract", () => {
      const a = readDoc(agentsPath);
      expect(a).toContain("internal/milestones/m9-live-workflow-execution.md");
      expect(a).toContain("internal/contracts/live-workflow-execution.md");
    });

    it("records that M9 kept the M8 marker until M10 closeout", () => {
      const a = readDoc(agentsPath);
      expect(a).toContain(M8_MARKER);
    });
  });

  describe("doctor milestone marker history (unchanged at the M9-00 decision gate)", () => {
    it("the current cli still has no Milestone 9 completion string", () => {
      const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
      expect(cli, "the M9-00 decision gate must not flip the doctor marker").not.toMatch(
        /Milestone 9:[^\n]*complete/i
      );
    });
  });

  describe("public docs hygiene (M9 planning stays internal)", () => {
    it("README.md does not leak M9 planning vocabulary", () => {
      const readme = readDoc("README.md");
      expect(readme).not.toMatch(/\bM9\b/);
      expect(readme).not.toMatch(/\bMilestone 9\b/);
      expect(readme).not.toMatch(/Live Workflow Execution/i);
    });

    it("docs/index.md does not link to internal M9 planning files", () => {
      const docsIndex = readDoc("docs/index.md");
      expect(docsIndex).not.toMatch(/m9-live-workflow-execution/);
      expect(docsIndex).not.toMatch(/live-workflow-execution\.md/);
    });
  });
});
