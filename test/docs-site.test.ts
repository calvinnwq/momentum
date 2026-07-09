import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("docs static site", () => {
  const index = read("docs/index.html");
  const styles = read("docs/assets/styles.css");
  const script = read("docs/assets/site.js");

  it("uses the HTML front door as the docs root", () => {
    expect(fs.existsSync(path.join(repoRoot, "docs/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "docs/index.md"))).toBe(false);
    expect(read("README.md")).toContain("[docs](docs/index.html)");
  });

  it("loads local docs assets only", () => {
    expect(index).toContain('href="assets/styles.css"');
    expect(index).toContain('src="assets/site.js"');
    expect(index).not.toMatch(/<script[^>]+src=["']https?:/);
    expect(index).not.toMatch(/<link[^>]+href=["']https?:/);
  });

  it("presents the current Momentum runtime shape", () => {
    for (const phrase of [
      "AI-native workflow backbone",
      "skeleton for creating AI-native repo workflows",
      "Workflow backbone",
      "Evidence and adapters",
      "Daemon and recovery",
      "Executors and apply",
      "OpenClaw supervise",
      "workflow run preview-coding",
      "End-to-end smoke",
      "workflow run start --run-id demo-1",
      "workflow status demo-1 --json",
      "workflow handoff demo-1 --json",
    ]) {
      expect(index).toContain(phrase);
    }
  });

  it("does not advertise the retired goal-first command lane", () => {
    for (const retired of [
      "goal start",
      "goal-start.html",
      "worker-run.html",
      'href="status.html"',
      'href="logs.html"',
      'href="handoff.html"',
    ]) {
      expect(index).not.toContain(retired);
      expect(script).not.toContain(retired);
    }
    for (const page of [
      "docs/goal-start.md",
      "docs/worker-run.md",
      "docs/status.md",
      "docs/logs.md",
      "docs/handoff.md",
    ]) {
      expect(fs.existsSync(path.join(repoRoot, page)), `${page} should not exist`).toBe(false);
    }
  });

  it("keeps docs navigation aligned with shipped reference pages", () => {
    for (const rel of [
      "walkthrough.html",
      "goal-spec.html",
      "workflow-commands.html",
      "openclaw-supervise.html",
      "evidence-commands.html",
      "intent-commands.html",
    ]) {
      expect(script).toContain(rel);
      const sourceMarkdown = rel.replace(/\.html$/, ".md");
      expect(fs.existsSync(path.join(repoRoot, "docs", sourceMarkdown))).toBe(true);
    }
  });

  it("keeps the ArtShelf and Agent Swarm inspired docs affordances", () => {
    for (const selector of [".masthead", ".sidebar", ".toc-col", ".palette", ".copy-btn"]) {
      expect(styles).toContain(selector);
    }
    for (const behavior of ["renderSidebar", "renderToc", "renderCopyButtons", "openPalette"]) {
      expect(script).toContain(behavior);
    }
  });
});
