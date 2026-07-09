import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const readmePath = path.join(repoRoot, "README.md");
const oxlintConfigPath = path.join(repoRoot, ".oxlintrc.json");
const prettierConfigPath = path.join(repoRoot, ".prettierrc.json");
const prettierIgnorePath = path.join(repoRoot, ".prettierignore");
const prettierChangedScriptPath = path.join(
  repoRoot,
  "scripts/prettier-changed.mjs",
);

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        result.stderr || result.stdout || ""
      }`,
    );
  }

  return result;
};

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

  it("checks committed branch changes against the default branch when no base is supplied", () => {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "momentum-prettier-changed-"),
    );

    try {
      run("git", ["init", "--initial-branch=main"], tmp);
      run("git", ["config", "user.email", "test@example.com"], tmp);
      run("git", ["config", "user.name", "Test User"], tmp);
      fs.writeFileSync(path.join(tmp, "changed.ts"), "const value = 1;\n");
      run("git", ["add", "changed.ts"], tmp);
      run("git", ["commit", "-m", "initial"], tmp);
      run("git", ["checkout", "-b", "feature"], tmp);
      fs.writeFileSync(path.join(tmp, "changed.ts"), "const value={a:1}\n");
      run("git", ["add", "changed.ts"], tmp);
      run("git", ["commit", "-m", "change format"], tmp);

      const result = spawnSync(
        process.execPath,
        [prettierChangedScriptPath, "--check"],
        {
          cwd: tmp,
          encoding: "utf8",
          env: {
            ...process.env,
            MOMENTUM_FORMAT_BASE: "",
            PATH: `${path.join(repoRoot, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("changed.ts");
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
