import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared scaffolding for the built-binary smoke suite.
 *
 * The milestone-scoped smoke files under `test/*smoke.test.ts` all drive the
 * real `dist/index.js` CLI against disposable git repos and temp data dirs.
 * This module owns the pieces every smoke file needs so they can stay focused
 * on a single milestone's behavior:
 *
 *   - `buildCli` / `cleanupTempRoots` are registered per file via
 *     `beforeAll(buildCli, 60_000)` and `afterEach(cleanupTempRoots)`.
 *   - `runCliBinary` / `runCliBinaryAsync` spawn the built CLI.
 *   - `makeTempDir` / `runGit` / `initDisposableRepo` set up disposable repos.
 *
 * It is not a test file (no `*.test.ts` suffix, lives under `test/helpers/`),
 * so neither the fast lane nor the integration lane collects it directly.
 */

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
export const CLI_BIN = path.join(REPO_ROOT, "dist", "index.js");

export const SMOKE_GOAL_SPEC = `---
title: Smoke Goal
runner: fake
verification:
  - "true"
---

End-to-end smoke goal.
`;

export type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

/**
 * Build the CLI binary before a smoke file's tests run. Register with
 * `beforeAll(buildCli, 60_000)` so each smoke file proves the freshly built
 * `dist/index.js` artifact rather than a stale one.
 */
export function buildCli(): void {
  execFileSync("pnpm", ["build"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!fs.existsSync(CLI_BIN)) {
    throw new Error(`smoke: built CLI not found at ${CLI_BIN}`);
  }
}

/**
 * Remove every temp dir created via `makeTempDir`. Register with
 * `afterEach(cleanupTempRoots)`.
 */
export function cleanupTempRoots(): void {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function initDisposableRepo(): string {
  const dir = makeTempDir("momentum-smoke-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "smoke@example.com"]);
  runGit(dir, ["config", "user.name", "Smoke Tester"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "smoke init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

export function stripNodeWarnings(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    if (/^\(node:\d+\) ExperimentalWarning:/u.test(line)) return false;
    if (/^\(Use `node --trace-warnings/.test(line)) return false;
    return true;
  });
  const result = filtered.join("\n").trim();
  return result.length === 0 ? "" : result + (text.endsWith("\n") ? "\n" : "");
}

export function runCliBinary(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): CliResult {
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: stripNodeWarnings(result.stderr ?? "")
  };
}

export async function runCliBinaryAsync(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<CliResult> {
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: stripNodeWarnings(Buffer.concat(stderrChunks).toString("utf-8"))
      });
    });
  });
}
