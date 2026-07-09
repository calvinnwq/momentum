import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const skillRoot = path.join(repoRoot, "skills", "momentum");
const resolver = path.join(skillRoot, "scripts", "resolve-momentum-cli.mjs");

function readSkillFile(relative: string): string {
  return fs.readFileSync(path.join(skillRoot, relative), "utf8");
}

function runResolver(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return runResolverFile(resolver, args, env);
}

function runResolverFile(
  resolverPath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
) {
  return spawnSync(process.execPath, [resolverPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("public Momentum skill", () => {
  it("has a portable skill shape with UI metadata and progressive references", () => {
    const skill = readSkillFile("SKILL.md");
    const openai = readSkillFile("agents/openai.yaml");

    expect(skill).toContain("name: momentum");
    expect(skill).toContain("description: Operate Momentum");
    for (const rel of [
      "references/cli-discovery.md",
      "references/workflow-runs.md",
      "references/gates-recovery.md",
      "references/evidence-logs.md",
      "scripts/resolve-momentum-cli.mjs"
    ]) {
      expect(fs.existsSync(path.join(skillRoot, rel)), `${rel} should exist`).toBe(true);
      expect(skill, `SKILL.md should mention ${rel}`).toContain(rel);
    }

    expect(openai).toContain('display_name: "Momentum"');
    expect(openai).toContain('default_prompt: "Use $momentum');
  });

  it("keeps private deployment vocabulary out of the public skill", () => {
    const files = [
      "SKILL.md",
      "references/cli-discovery.md",
      "references/workflow-runs.md",
      "references/gates-recovery.md",
      "references/evidence-logs.md"
    ];
    const body = files.map(readSkillFile).join("\n");

    for (const forbidden of [
      /\bNGX-\d+\b/,
      /\/Users\/(?:calvinnwq|ngxcalvin)\b/,
      /\bDiscord\b/,
      /\bCWFP\b/,
      /\bcwfp\b/,
      /\bGNHF\b/,
      /\bno-mistakes\b/,
      /\bLinear\b/,
      /\bOpenClaw\b/
    ]) {
      expect(body).not.toMatch(forbidden);
    }
  });

  it("keeps referenced command examples aligned with the public help surface", () => {
    const help = fs.readFileSync(path.join(repoRoot, "src", "renderers", "help.ts"), "utf8");
    const docs = [
      "SKILL.md",
      "references/workflow-runs.md",
      "references/gates-recovery.md",
      "references/evidence-logs.md"
    ].map(readSkillFile).join("\n");

    for (const command of [
      "workflow run preview-coding",
      "workflow run start-coding",
      "workflow run start",
      "workflow run approve",
      "workflow run decide",
      "workflow run clear-recovery",
      "workflow run update-step",
      "workflow run monitor",
      "workflow run watch",
      "workflow run events",
      "workflow run logs",
      "workflow status",
      "workflow handoff",
      "evidence ingest",
      "evidence list",
      "recovery clear",
      "doctor"
    ]) {
      expect(docs, `skill should document ${command}`).toContain(command);
      expect(help, `help surface should expose ${command}`).toContain(command);
    }
  });

  it("resolves MOMENTUM_CLI before PATH or checkout fallbacks", () => {
    const binDir = makeTempDir("momentum-skill-bin-");
    const fake = path.join(binDir, "momentum-fake");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(fake, 0o755);

    const result = runResolver(["--json"], {
      ...process.env,
      MOMENTUM_CLI: `${fake} --from-env`,
      PATH: ""
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      argv: string[];
    };
    expect(parsed).toMatchObject({ ok: true, source: "env" });
    expect(parsed.argv).toEqual([fake, "--from-env"]);
  });

  it("resolves Windows PATH commands that already include an extension", () => {
    const binDir = makeTempDir("momentum-skill-win-path-");
    const fake = path.join(binDir, "node.exe");
    fs.writeFileSync(fake, "", "utf8");

    const prelude = "Object.defineProperty(process, 'platform', { value: 'win32' });";
    const result = spawnSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(prelude)}`, resolver, "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          MOMENTUM_CLI: "node.exe --from-env",
          PATHEXT: ".EXE;.CMD",
          PATH: binDir
        },
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      argv: string[];
    };
    expect(parsed).toMatchObject({ ok: true, source: "env" });
    expect(parsed.argv).toEqual(["node.exe", "--from-env"]);
  });

  it("preserves backslashes in MOMENTUM_CLI command paths", () => {
    const binDir = makeTempDir("momentum-skill-backslash-");
    const fake = path.join(binDir, "momentum\\fake");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(fake, 0o755);

    const result = runResolver(["--json"], {
      ...process.env,
      MOMENTUM_CLI: `${fake} --from-env`,
      PATH: ""
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      argv: string[];
    };
    expect(parsed).toMatchObject({ ok: true, source: "env" });
    expect(parsed.argv).toEqual([fake, "--from-env"]);
  });

  it("resolves momentum from PATH when no env override is present", () => {
    const binDir = makeTempDir("momentum-skill-path-");
    const fake = path.join(binDir, "momentum");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(fake, 0o755);

    const result = runResolver(["--json", "--cwd", os.tmpdir()], {
      ...process.env,
      MOMENTUM_CLI: "",
      PATH: binDir
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      argv: string[];
      resolvedPath: string;
    };
    expect(parsed).toMatchObject({ ok: true, source: "path" });
    expect(parsed.argv).toEqual(["momentum"]);
    expect(parsed.resolvedPath).toBe(fake);
  });

  it("uses a built dev checkout only when the built CLI exists", () => {
    const checkout = makeTempDir("momentum-skill-checkout-");
    fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "@calvinnwq/momentum" }),
      "utf8"
    );
    fs.writeFileSync(path.join(checkout, "ARCHITECTURE.md"), "# Momentum\n", "utf8");
    fs.writeFileSync(path.join(checkout, "dist", "index.js"), "console.log('ok')\n", "utf8");

    const result = runResolver(["--json", "--cwd", checkout], {
      ...process.env,
      MOMENTUM_CLI: "",
      PATH: ""
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      argv: string[];
      checkout: string;
    };
    expect(parsed).toMatchObject({ ok: true, source: "dev-checkout", checkout });
    expect(parsed.argv).toEqual(["node", path.join(checkout, "dist", "index.js")]);
  });

  it("finds the bundled checkout from the installed skill when cwd is another repo", () => {
    const checkout = makeTempDir("momentum-skill-bundled-checkout-");
    const otherRepo = makeTempDir("momentum-skill-other-repo-");
    const bundledResolver = path.join(
      checkout,
      "skills",
      "momentum",
      "scripts",
      "resolve-momentum-cli.mjs"
    );
    fs.mkdirSync(path.dirname(bundledResolver), { recursive: true });
    fs.mkdirSync(path.join(checkout, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "@calvinnwq/momentum" }),
      "utf8"
    );
    fs.writeFileSync(path.join(checkout, "ARCHITECTURE.md"), "# Momentum\n", "utf8");
    fs.writeFileSync(path.join(checkout, "dist", "index.js"), "console.log('ok')\n", "utf8");
    fs.copyFileSync(resolver, bundledResolver);

    const result = runResolverFile(bundledResolver, ["--json", "--cwd", otherRepo], {
      ...process.env,
      MOMENTUM_CLI: "",
      PATH: ""
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      argv: string[];
      checkout: string;
    };
    const resolvedCheckout = fs.realpathSync(checkout);
    expect(parsed).toMatchObject({
      ok: true,
      source: "dev-checkout",
      checkout: resolvedCheckout
    });
    expect(parsed.argv).toEqual(["node", path.join(resolvedCheckout, "dist", "index.js")]);
  });

  it("fails closed when a dev checkout is present but not built", () => {
    const checkout = makeTempDir("momentum-skill-unbuilt-");
    fs.writeFileSync(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "@calvinnwq/momentum" }),
      "utf8"
    );
    fs.writeFileSync(path.join(checkout, "ARCHITECTURE.md"), "# Momentum\n", "utf8");

    const result = runResolver(["--json", "--cwd", checkout], {
      ...process.env,
      MOMENTUM_CLI: "",
      PATH: ""
    });

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stderr) as {
      ok: boolean;
      code: string;
      message: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("dev_checkout_not_built");
    expect(parsed.message).toContain("pnpm build");
  });

  it("ships the public skill in the npm package artifact", () => {
    const stdout = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10
    });
    const pack = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(pack[0]?.files.map((file) => file.path));

    for (const expected of [
      "skills/momentum/SKILL.md",
      "skills/momentum/agents/openai.yaml",
      "skills/momentum/scripts/resolve-momentum-cli.mjs",
      "skills/momentum/references/cli-discovery.md",
      "skills/momentum/references/workflow-runs.md",
      "skills/momentum/references/gates-recovery.md",
      "skills/momentum/references/evidence-logs.md"
    ]) {
      expect(files.has(expected), `${expected} should be packed`).toBe(true);
    }
  });
});
