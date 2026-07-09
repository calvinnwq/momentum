import { describe, expect, it } from "vitest";

import { readRepoFile } from "./helpers/repo-docs.js";

/**
 * Operator docs must keep documenting the shipped command surface. These pins
 * guard that public/operator pages stay aligned with wire-stable behavior;
 * they are behavior-coverage checks, not doc formatting checks.
 */
describe("operator docs coverage", () => {
  it("keeps the operational-safety CLI surface documented in README", () => {
    const readme = readRepoFile("README.md");
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

  it("keeps runner profiles documented as operator-facing truth", () => {
    const runners = readRepoFile("docs/runners.md");
    expect(runners).toContain("fake");
    expect(runners).toContain("trusted-shell");
    expect(runners).toContain("acp");
  });

  it("keeps source commands documented for operators", () => {
    const docs = readRepoFile("docs/source-commands.md");
    expect(docs).toContain("source list");
    expect(docs).toContain("source reconcile");
  });

  it("keeps external-apply documented as an operator-facing command", () => {
    const intentDocs = readRepoFile("docs/intent-commands.md");
    expect(intentDocs).toContain("--external-apply");
    expect(intentDocs).toContain("applyPolicy");
    expect(intentDocs).toContain("externalApply");
  });

  it("keeps workflow commands documented for operators", () => {
    const docs = readRepoFile("docs/workflow-commands.md");
    for (const cmd of [
      "workflow import",
      "workflow status",
      "workflow handoff",
      "approve",
      "decide",
      "update-step",
      "clear-recovery",
      "monitor",
      "logs"
    ]) {
      expect(docs).toContain(cmd);
    }
  });

  it("keeps native monitor delivery cleanup semantics documented", () => {
    const docs = readRepoFile("docs/workflow-commands.md");
    for (const phrase of [
      "Monitor delivery wrappers",
      "progress.emit",
      "recoverable terminal failures",
      "momentum-native-coding",
      "mwf-*",
      "operator convention"
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it("keeps the live-wrapper operator profile documented", () => {
    const daemonDocs = readRepoFile("docs/daemon.md");
    expect(daemonDocs).toContain("MOMENTUM_LIVE_WRAPPER_PROFILE");
    expect(daemonDocs).toContain("MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG");
    expect(daemonDocs).toContain("MOMENTUM_RESULT_PATH");
    expect(daemonDocs).toMatch(/operator\s+setup failure/);
  });
});
