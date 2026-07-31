import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NGX-668 (NAM-03E) current-source / current-doc vocabulary guard.
 *
 * `MOMENTUM_HOST_BINDINGS_FILE` is the only active selector for machine-local
 * execution bindings. Active source, diagnostics, checked-in configuration,
 * and current operator documentation must not teach live-wrapper-profile
 * vocabulary; the retired selector and profile shape may be named only where
 * they are detected and refused with a migration diagnostic.
 */

const REPO_ROOT = process.cwd();

/** The only source module allowed to spell the retired selector: detection. */
const RETIRED_SELECTOR_DETECTION_MODULE =
  "src/core/workflow/live-wrapper/daemon-host-bindings.ts";

function listFiles(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    out.push(path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

describe("host-binding vocabulary guard (NGX-668)", () => {
  it("spells the retired MOMENTUM_LIVE_WRAPPER_PROFILE selector only at its detection site", () => {
    const offenders = listFiles("src", ".ts").filter(
      (file) =>
        file !== RETIRED_SELECTOR_DETECTION_MODULE &&
        fs
          .readFileSync(path.join(REPO_ROOT, file), "utf8")
          .includes("MOMENTUM_LIVE_WRAPPER_PROFILE"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the retired selector out of current operator documentation except migration guidance", () => {
    const docFiles = [
      ...listFiles("docs", ".md"),
      "README.md",
      "SPEC.md",
      "ARCHITECTURE.md",
      "VISION.md",
      "AGENTS.md",
    ];
    const offenders: string[] = [];
    for (const file of docFiles) {
      const lines = fs
        .readFileSync(path.join(REPO_ROOT, file), "utf8")
        .split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("MOMENTUM_LIVE_WRAPPER_PROFILE")) return;
        if (/retired/i.test(line)) return;
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("does not teach live-wrapper-profile vocabulary in active source or current docs", () => {
    const files = [
      ...listFiles("src", ".ts"),
      ...listFiles("src", ".md"),
      ...listFiles("src", ".mjs"),
      ...listFiles("docs", ".md"),
      "README.md",
      "SPEC.md",
      "ARCHITECTURE.md",
      "VISION.md",
      "AGENTS.md",
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs
        .readFileSync(path.join(REPO_ROOT, file), "utf8")
        .split("\n");
      lines.forEach((line, index) => {
        if (!/live[- ]wrapper profile/i.test(line)) return;
        // The retired shape may be named where it is refused with migration
        // guidance; every other current mention teaches retired vocabulary.
        if (/retired|migration/i.test(line)) return;
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the retired checked-in profile path out of the repository", () => {
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          "profiles/coding-workflow-live-wrapper.profile.json",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(REPO_ROOT, "bindings/coding-workflow.host-bindings.json"),
      ),
    ).toBe(true);
  });

  it("ships the checked-in host bindings in the strict { bindings } shape", () => {
    const doc = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "bindings/coding-workflow.host-bindings.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["bindings"]);
  });
});
