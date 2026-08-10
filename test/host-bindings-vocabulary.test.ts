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

describe("host-binding vocabulary guard (NGX-668)", () => {
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
