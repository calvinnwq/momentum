import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runVerification } from "../src/verification.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-verification-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function setup(): { repoPath: string; logPath: string } {
  const repoPath = makeTempDir();
  const logDir = makeTempDir("momentum-verification-log-");
  const logPath = path.join(logDir, "verification.log");
  return { repoPath, logPath };
}

describe("runVerification", () => {
  it("returns ok=true and records each command when all commands pass", () => {
    const { repoPath, logPath } = setup();

    const out = runVerification({
      repoPath,
      commands: ["echo first", "echo second"],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.command).toBe("echo first");
    expect(out.results[0]?.exit_code).toBe(0);
    expect(out.results[0]?.succeeded).toBe(true);
    expect(out.results[0]?.timed_out).toBe(false);
    expect(out.results[1]?.command).toBe("echo second");
    expect(out.results[1]?.succeeded).toBe(true);
  });

  it("vacuously succeeds when no commands are provided", () => {
    const { repoPath, logPath } = setup();

    const out = runVerification({
      repoPath,
      commands: [],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.results).toEqual([]);
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("no verification commands configured");
  });

  it("writes the verification log with command output and a summary", () => {
    const { repoPath, logPath } = setup();

    runVerification({
      repoPath,
      commands: ["echo hello-world"],
      timeoutSec: 30,
      logPath
    });

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("[verify] running: echo hello-world");
    expect(log).toContain(`[verify]   cwd: ${repoPath}`);
    expect(log).toContain("hello-world");
    expect(log).toContain("[verify]   exit_code: 0");
    expect(log).toContain("[verify]   result: ok");
    expect(log).toContain("[verify] summary: all 1 verification command(s) passed");
    expect(log.endsWith("\n")).toBe(true);
  });

  it("executes commands with repoPath as cwd", () => {
    const { repoPath, logPath } = setup();
    fs.writeFileSync(path.join(repoPath, "marker.txt"), "present\n", "utf-8");

    const out = runVerification({
      repoPath,
      commands: ["cat marker.txt"],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(true);
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("present");
  });

  it("stops at the first failing command and returns command_failed", () => {
    const { repoPath, logPath } = setup();

    const out = runVerification({
      repoPath,
      commands: ["echo first", "false", "echo unreached"],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;

    expect(out.code).toBe("command_failed");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.succeeded).toBe(true);
    expect(out.results[1]?.command).toBe("false");
    expect(out.results[1]?.succeeded).toBe(false);
    expect(out.results[1]?.exit_code).not.toBe(0);
    expect(out.error).toContain("false");

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("[verify]   result: failed");
    expect(log).not.toContain("echo unreached");
    expect(log).toContain("[verify] summary: verification failed");
  });

  it("returns command_timed_out when a command exceeds the timeout", () => {
    const { repoPath, logPath } = setup();

    const out = runVerification({
      repoPath,
      commands: ["sleep 5"],
      timeoutSec: 1,
      logPath
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;

    expect(out.code).toBe("command_timed_out");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.timed_out).toBe(true);
    expect(out.results[0]?.succeeded).toBe(false);
    expect(out.error).toContain("timed out");

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("[verify]   result: timed_out");
  });

  it("rejects invalid repoPath", () => {
    const { logPath } = setup();

    const out = runVerification({
      repoPath: "",
      commands: ["echo hi"],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
  });

  it("rejects non-positive timeoutSec", () => {
    const { repoPath, logPath } = setup();

    const zero = runVerification({
      repoPath,
      commands: ["echo hi"],
      timeoutSec: 0,
      logPath
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.code).toBe("invalid_input");

    const negative = runVerification({
      repoPath,
      commands: ["echo hi"],
      timeoutSec: -1,
      logPath
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.code).toBe("invalid_input");

    const fractional = runVerification({
      repoPath,
      commands: ["echo hi"],
      timeoutSec: 1.5,
      logPath
    });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.code).toBe("invalid_input");
  });

  it("rejects non-string commands", () => {
    const { repoPath, logPath } = setup();

    const out = runVerification({
      repoPath,
      commands: ["echo hi", "   "],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toMatch(/non-empty string/);
  });

  it("rejects an empty logPath", () => {
    const { repoPath } = setup();

    const out = runVerification({
      repoPath,
      commands: ["echo hi"],
      timeoutSec: 30,
      logPath: ""
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
  });

  it("returns log_write_failed when the log path is unwritable", () => {
    const { repoPath } = setup();
    const dir = makeTempDir("momentum-verification-readonly-");
    const logPath = path.join(dir, "as-dir");
    fs.mkdirSync(logPath);

    const out = runVerification({
      repoPath,
      commands: ["echo hi"],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("log_write_failed");
  });

  it("returns spawn_failed when repoPath does not exist", () => {
    const ghost = path.join(makeTempDir(), "missing-repo");
    const logDir = makeTempDir("momentum-verification-log-");
    const logPath = path.join(logDir, "verification.log");

    const out = runVerification({
      repoPath: ghost,
      commands: ["echo hi"],
      timeoutSec: 30,
      logPath
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("spawn_failed");
  });
});
