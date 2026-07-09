import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const readmePath = path.join(repoRoot, "README.md");
const oxlintConfigPath = path.join(repoRoot, ".oxlintrc.json");
const prettierConfigPath = path.join(repoRoot, ".prettierrc.json");
const prettierIgnorePath = path.join(repoRoot, ".prettierignore");

describe("package verification scripts", () => {
  it("exposes the standard local verification gates and documents them in the README", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const readme = fs.readFileSync(readmePath, "utf8");

    expect(packageJson.scripts).toMatchObject({
      lint: expect.any(String),
      format: expect.any(String),
      "format:check": expect.any(String),
    });
    expect(packageJson.scripts?.lint).toContain("oxlint");
    expect(packageJson.scripts?.lint).not.toContain("tsc -p");
    expect(packageJson.scripts?.format).toContain(
      "prettier-changed.mjs --write",
    );
    expect(packageJson.scripts?.["format:check"]).toContain(
      "prettier-changed.mjs --check",
    );
    expect(packageJson.devDependencies).toMatchObject({
      oxlint: expect.any(String),
      prettier: expect.any(String),
    });
    expect(readme).toContain("pnpm lint");
    expect(readme).toContain("pnpm format");
    expect(readme).toContain("pnpm format:check");
  });

  it("keeps real lint and format tool configuration checked in", () => {
    expect(fs.existsSync(oxlintConfigPath)).toBe(true);
    expect(fs.existsSync(prettierConfigPath)).toBe(true);
    expect(fs.existsSync(prettierIgnorePath)).toBe(true);
    expect(fs.readFileSync(prettierIgnorePath, "utf8")).toContain("docs/");
  });
});
