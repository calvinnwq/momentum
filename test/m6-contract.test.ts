import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

const M6_ISSUE_ORDER = [
  "NGX-295",
  "NGX-296",
  "NGX-297",
  "NGX-299",
  "NGX-298",
  "NGX-300",
  "NGX-301",
  "NGX-302"
] as const;

const M6_INVARIANTS = [
  "audit-before-apply",
  "two-phase",
  "blocked",
  "intent_apply_in_progress",
  "comment-only",
  "idempotency marker",
  "single-issue reconcile",
  "api.linear.app"
] as const;

const M6_API_LINEAR_NEGATION = /(must not|never|no).*api\.linear\.app|api\.linear\.app.*(must not|never|no)/i;

describe("M6 contract docs (NGX-295 setup)", () => {
  describe("docs directory structure", () => {
    it("has docs/roadmap.md", () => {
      const p = path.join(repoRoot, "docs", "roadmap.md");
      expect(fs.existsSync(p), "docs/roadmap.md should exist").toBe(true);
    });

    it("has docs/milestones/m5-source-adapters.md", () => {
      const p = path.join(repoRoot, "docs", "milestones", "m5-source-adapters.md");
      expect(fs.existsSync(p), "docs/milestones/m5-source-adapters.md should exist").toBe(true);
    });

    it("has docs/milestones/m6-external-apply.md", () => {
      const p = path.join(repoRoot, "docs", "milestones", "m6-external-apply.md");
      expect(fs.existsSync(p), "docs/milestones/m6-external-apply.md should exist").toBe(true);
    });

    it("has docs/contracts/intent-apply.md", () => {
      const p = path.join(repoRoot, "docs", "contracts", "intent-apply.md");
      expect(fs.existsSync(p), "docs/contracts/intent-apply.md should exist").toBe(true);
    });

    it("has docs/contracts/source-adapters.md", () => {
      const p = path.join(repoRoot, "docs", "contracts", "source-adapters.md");
      expect(fs.existsSync(p), "docs/contracts/source-adapters.md should exist").toBe(true);
    });
  });

  describe("docs/roadmap.md", () => {
    const roadmap = readDoc(path.join("docs", "roadmap.md"));

    it("names all milestones in order", () => {
      let cursor = -1;
      for (const m of [
        "Milestone 1",
        "Milestone 2",
        "Milestone 3",
        "Milestone 4",
        "Milestone 5",
        "Milestone 6"
      ]) {
        const next = roadmap.indexOf(m, cursor + 1);
        expect(next, `${m} should appear after the previous milestone`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("lists the planned M6 issue order matching the Linear milestone", () => {
      let cursor = -1;
      for (const id of M6_ISSUE_ORDER) {
        const next = roadmap.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M6 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });
  });

  describe("docs/milestones/m6-external-apply.md", () => {
    const m6 = readDoc(path.join("docs", "milestones", "m6-external-apply.md"));

    it("documents the planned M6 issue order verbatim", () => {
      let cursor = -1;
      for (const id of M6_ISSUE_ORDER) {
        const next = m6.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M6 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("requires NGX-299 audit surfaces before NGX-298 external apply", () => {
      const auditIdx = m6.indexOf("NGX-299");
      const applyIdx = m6.indexOf("NGX-298");
      expect(auditIdx, "NGX-299 should be mentioned").toBeGreaterThanOrEqual(0);
      expect(applyIdx, "NGX-298 should be mentioned").toBeGreaterThanOrEqual(0);
      expect(auditIdx, "NGX-299 should precede NGX-298 in the issue ordering").toBeLessThan(applyIdx);
    });

    it("names M6 explicit non-goals (no auto-apply outside policy, no inbound webhooks, no UI)", () => {
      expect(m6).toMatch(/non-goals?/i);
      for (const ng of [
        "Dashboard or UI surface",
        "Inbound webhooks",
        "Autonomous",
        "non-Linear adapters",
        "runner/sandbox"
      ]) {
        expect(m6).toContain(ng);
      }
    });

    it("references the intent-apply contract", () => {
      expect(m6).toMatch(/intent-apply/);
    });
  });

  describe("docs/contracts/intent-apply.md", () => {
    const intentApply = readDoc(path.join("docs", "contracts", "intent-apply.md"));

    it("captures the M6 safety invariants", () => {
      for (const term of M6_INVARIANTS) {
        expect(intentApply).toContain(term);
      }
    });

    it("documents the two-phase external apply flow (claim, audit-before-write, external write, finalize)", () => {
      expect(intentApply).toMatch(/claim/i);
      expect(intentApply).toMatch(/audit/i);
      expect(intentApply).toMatch(/external write/i);
      expect(intentApply).toMatch(/finalize/i);
    });

    it("documents the blocked / non-replay state after external-write-success + audit-finalize-failure", () => {
      expect(intentApply).toMatch(/blocked/i);
      expect(intentApply).toMatch(/non-replay/i);
    });

    it("documents the per-intent concurrency guard with a stable intent_apply_in_progress result", () => {
      expect(intentApply).toContain("intent_apply_in_progress");
      expect(intentApply).toMatch(/CAS|compare-and-swap|concurrency guard/i);
    });

    it("documents the comment-only default unless target status mutation is configured", () => {
      expect(intentApply).toContain("comment-only");
      expect(intentApply).toMatch(/Linear/);
    });

    it("documents the idempotency marker shape and dedupe role", () => {
      expect(intentApply).toContain("idempotency marker");
      expect(intentApply).toMatch(/dedupe|deduplication|reconcile/i);
    });

    it("documents single-issue post-apply reconcile scope", () => {
      expect(intentApply).toContain("single-issue reconcile");
    });

    it("documents the test guard against real api.linear.app calls", () => {
      expect(intentApply).toContain("api.linear.app");
      expect(intentApply).toMatch(M6_API_LINEAR_NEGATION);
    });
  });

  describe("docs/contracts/source-adapters.md", () => {
    const sources = readDoc(path.join("docs", "contracts", "source-adapters.md"));

    it("documents source adapter boundaries (read-only, durable local tables, no credentials in state)", () => {
      expect(sources).toMatch(/read-?only/i);
      expect(sources).toMatch(/snapshot|reconciliation|SourceItem/i);
      expect(sources).toMatch(/credential/i);
    });
  });

  describe("docs/milestones/m5-source-adapters.md", () => {
    const m5 = readDoc(path.join("docs", "milestones", "m5-source-adapters.md"));

    it("frames M5 as durable intents / source adapters, NOT external apply", () => {
      expect(m5).toMatch(/durable.*intent|intent.*durable/i);
      expect(m5).toMatch(/does not.*(external|automatic).*apply|no.*external.*write|policy-?gated/i);
    });

    it("does not claim external apply was implemented in M5", () => {
      expect(m5).not.toMatch(/M5 (added|implements|implemented|introduces|provides|performs) (an? )?external apply/i);
      expect(m5).not.toMatch(/external apply (was|landed|shipped|implemented) in M5/i);
    });
  });

  describe("README.md OSS-facing reshape", () => {
    const readme = readDoc("README.md");

    it("includes a compact shield block near the top (CI/Node/TypeScript/license)", () => {
      const header = readme.slice(0, 4000);
      expect(header).toMatch(/!\[.*\]\(.*shields?\.io.*\)|<img[^>]+shields?\.io/i);
    });

    it("links to docs/roadmap.md", () => {
      expect(readme).toMatch(/docs\/roadmap\.md/);
    });

    it("links to docs/milestones/m6-external-apply.md", () => {
      expect(readme).toMatch(/docs\/milestones\/m6-external-apply\.md/);
    });

    it("links to docs/contracts/intent-apply.md", () => {
      expect(readme).toMatch(/docs\/contracts\/intent-apply\.md/);
    });
  });

  describe("AGENTS.md compact agent contract", () => {
    const agents = readDoc("AGENTS.md");

    it("names the active milestone (M6)", () => {
      expect(agents).toMatch(/Milestone 6/);
    });

    it("points future agents to docs/ for the source of truth", () => {
      expect(agents).toMatch(/docs\/(roadmap|milestones|contracts)/);
    });
  });

  it("doctor is NOT prematurely marked M6 complete", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toMatch(/Milestone 6:.*complete/);
    expect(cli).toContain(
      "Milestone 5: source adapters and evidence sync (NGX-287, NGX-288, NGX-289, NGX-290, NGX-291, NGX-292, NGX-293, NGX-294) complete"
    );
  });
});
