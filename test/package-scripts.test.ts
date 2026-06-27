import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const readmePath = path.join(repoRoot, "README.md");

describe("package verification scripts", () => {
  it("exposes the standard local verification gates and documents them in the README", () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const readme = fs.readFileSync(readmePath, "utf8");

    expect(packageJson.scripts).toMatchObject({
      lint: expect.any(String),
      "format:check": expect.any(String),
    });
    expect(readme).toContain("pnpm lint");
    expect(readme).toContain("pnpm format:check");
  });
});
