import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  buildCli,
  cleanupTempRoots,
  initDisposableRepo,
  makeTempDir,
  runCliBinary,
  runGit
} from "./helpers/smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

const TRUSTED_SHELL_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "Trusted shell wrote smoke-fixture.txt.",
  key_changes_made: ["Wrote smoke-fixture.txt"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "trusted-shell smoke",
    body: "",
    breaking: false
  }
});

describe("Milestone 4 real-runner end-to-end smoke (NGX-286)", () => {

  it(
    "runs a trusted-shell happy-path goal end-to-end through the built CLI and surfaces commit/logs/handoff",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m4-ok-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const fixturePath = path.join(repo, "smoke-fixture.txt");
      const scriptPath = path.join(dataDir, "trusted-shell-success.sh");
      fs.writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          "set -eu",
          `printf 'hello smoke trusted-shell\\n' > "${fixturePath}"`,
          `cat > "$MOMENTUM_RESULT_PATH" <<'JSON'`,
          TRUSTED_SHELL_RESULT_JSON,
          "JSON",
          "echo trusted-shell-stdout-marker",
          "echo trusted-shell-stderr-marker >&2"
        ].join("\n") + "\n",
        { encoding: "utf-8", mode: 0o755 }
      );
      const goalSpec = `---\ntitle: M4 Trusted Shell Smoke\nrunner: trusted-shell\nverification:\n  - "true"\ntrusted_shell:\n  command: /bin/sh\n  args: [${JSON.stringify(scriptPath)}]\n---\n\nApply the fixture via trusted-shell.\n`;
      fs.writeFileSync(goalFile, goalSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      expect(startPayload).toMatchObject({
        ok: true,
        command: "goal start",
        state: "iteration_complete",
        runner: "trusted-shell"
      });
      const profile = startPayload["runnerProfile"] as Record<string, unknown>;
      expect(profile).toMatchObject({
        kind: "trusted-shell",
        executes: true
      });
      expect(startPayload["runnerProfileSource"]).toBe("goal_frontmatter");

      const goalId = startPayload["goalId"] as string;
      const iter = startPayload["iteration"] as Record<string, unknown>;
      const commitSha = iter["commitSha"] as string;
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(commitSha).not.toBe(baseHead);
      expect(iter).toMatchObject({
        ok: true,
        runnerSuccess: true,
        goalComplete: false
      });

      expect(fs.existsSync(fixturePath)).toBe(true);
      expect(fs.readFileSync(fixturePath, "utf-8")).toContain(
        "hello smoke trusted-shell"
      );

      const goalDir = path.join(dataDir, "goals", goalId);
      const runnerLog = fs.readFileSync(
        path.join(goalDir, "iterations", "1", "runner.log"),
        "utf-8"
      );
      expect(runnerLog).toContain("[trusted-shell] start");
      expect(runnerLog).toContain("trusted-shell-stdout-marker");
      expect(runnerLog).toContain("trusted-shell-stderr-marker");
      expect(runnerLog).toContain("[trusted-shell] runner_success: true");

      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      const resultJsonField = logsPayload["resultJson"] as Record<
        string,
        unknown
      >;
      expect(resultJsonField).toMatchObject({
        exists: true,
        readable: true
      });
      expect(resultJsonField["parseError"]).toBeFalsy();

      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        state: "iteration_complete"
      });
      const handoffMd = fs.readFileSync(
        path.join(goalDir, "handoff.md"),
        "utf-8"
      );
      expect(handoffMd).toContain("- Runner: trusted-shell");
      expect(handoffMd).toContain(`- Commit SHA: ${commitSha}`);
    },
    120_000
  );

  it(
    "surfaces trusted-shell command_failed through built CLI and resets the worktree to base HEAD",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m4-fail-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const dirtyPath = path.join(repo, "smoke-half-done.txt");
      const scriptPath = path.join(dataDir, "trusted-shell-failure.sh");
      fs.writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          `printf 'partial-write\\n' > "${dirtyPath}"`,
          "echo trusted-shell-fail-stderr >&2",
          "exit 17"
        ].join("\n") + "\n",
        { encoding: "utf-8", mode: 0o755 }
      );
      const goalSpec = `---\ntitle: M4 Trusted Shell Failure Smoke\nrunner: trusted-shell\nverification:\n  - "true"\ntrusted_shell:\n  command: /bin/sh\n  args: [${JSON.stringify(scriptPath)}]\n---\n\nFail the iteration deterministically with a non-zero exit.\n`;
      fs.writeFileSync(goalFile, goalSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed",
        runner: "trusted-shell"
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({ ok: false, code: "command_failed" });
      const goalId = payload["goalId"] as string;

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(fs.existsSync(dirtyPath)).toBe(false);

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        state: "failed",
        runner: "trusted-shell"
      });
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      const statusFailure = statusIter["failure"] as Record<string, unknown>;
      expect(statusFailure).toMatchObject({ code: "command_failed" });

      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      const runnerLogField = logsPayload["runnerLog"] as Record<string, unknown>;
      expect(runnerLogField["readable"]).toBe(true);
      expect(runnerLogField["content"]).toContain("[trusted-shell] exit_code: 17");
      expect(runnerLogField["content"]).toContain("trusted-shell-fail-stderr");

      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        state: "failed"
      });
      const handoffMdContent = fs.readFileSync(
        path.join(dataDir, "goals", goalId, "handoff.md"),
        "utf-8"
      );
      expect(handoffMdContent).toContain("- Failure: command_failed - ");
    },
    120_000
  );

  it(
    "loads MOMENTUM.md defaults and respects CLI --runner override (precedence: CLI > frontmatter > MOMENTUM.md)",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      fs.writeFileSync(
        path.join(repo, "MOMENTUM.md"),
        `---\nrunner: trusted-shell\nverification:\n  - "true"\nverification_timeout_sec: 1200\n---\nSmoke policy notes body.\n`,
        "utf-8"
      );
      runGit(repo, ["add", "MOMENTUM.md"]);
      runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);

      const dataDir = makeTempDir("momentum-smoke-m4-policy-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const policyGoalSpec = `---\ntitle: M4 Policy Smoke\nverification:\n  - "true"\n---\n\nLoads runner from MOMENTUM.md unless overridden by CLI.\n`;
      fs.writeFileSync(goalFile, policyGoalSpec, "utf-8");

      // Default path (no --runner override): runner comes from MOMENTUM.md.
      const queued = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(queued.code, `goal start stderr: ${queued.stderr}`).toBe(0);
      const queuedPayload = JSON.parse(queued.stdout) as Record<
        string,
        unknown
      >;
      expect(queuedPayload).toMatchObject({
        ok: true,
        mode: "queued",
        runner: "trusted-shell"
      });
      expect(queuedPayload["runnerProfileSource"]).toBe("momentum_policy");
      const queuedPolicy = queuedPayload["policy"] as Record<string, unknown>;
      expect(queuedPolicy).toMatchObject({
        present: true,
        path: path.join(repo, "MOMENTUM.md")
      });
      const queuedConfig = queuedPolicy["config"] as Record<string, unknown>;
      expect(queuedConfig).toMatchObject({
        runner: "trusted-shell",
        verificationTimeoutSec: 1200
      });

      const queuedGoalId = queuedPayload["goalId"] as string;

      // CLI override: --runner fake beats both frontmatter and MOMENTUM.md.
      const overrideDataDir = makeTempDir("momentum-smoke-m4-policy-override-");
      const override = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--runner",
        "fake",
        "--data-dir",
        overrideDataDir,
        "--json"
      ]);
      expect(override.code, `override stderr: ${override.stderr}`).toBe(0);
      const overridePayload = JSON.parse(override.stdout) as Record<
        string,
        unknown
      >;
      expect(overridePayload).toMatchObject({
        ok: true,
        mode: "queued",
        runner: "fake"
      });
      expect(overridePayload["runnerProfileSource"]).toBe("cli_override");
      const overridePolicy = overridePayload["policy"] as Record<
        string,
        unknown
      >;
      expect(overridePolicy).toMatchObject({
        present: true,
        path: path.join(repo, "MOMENTUM.md")
      });

      // status surfaces the loaded policy fields too.
      const statusOut = runCliBinary([
        "status",
        queuedGoalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(statusOut.code, `status stderr: ${statusOut.stderr}`).toBe(0);
      const statusPayload = JSON.parse(statusOut.stdout) as Record<
        string,
        unknown
      >;
      const statusPolicy = statusPayload["policy"] as Record<string, unknown>;
      expect(statusPolicy).toMatchObject({
        configured: true,
        present: true
      });

      // doctor --repo surfaces the same MOMENTUM.md.
      const doctor = runCliBinary([
        "doctor",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
      const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
      const doctorPolicy = doctorPayload["policy"] as Record<string, unknown>;
      expect(doctorPolicy).toMatchObject({
        repoConfigured: true,
        present: true,
        path: path.join(repo, "MOMENTUM.md")
      });
    },
    60_000
  );

  it(
    "surfaces acp runtime_unavailable cleanly through the built CLI when the configured runtime binary is missing",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m4-acp-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const goalSpec = `---\ntitle: M4 ACP Smoke (runtime_unavailable)\nrunner: acp\nverification:\n  - "true"\nacp:\n  command: /definitely-missing-acp-runtime-for-smoke\n---\n\nACP runner that exercises the runtime_unavailable taxonomy when the runtime binary is missing.\n`;
      fs.writeFileSync(goalFile, goalSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed",
        runner: "acp"
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({ ok: false, code: "runtime_unavailable" });
      const goalId = payload["goalId"] as string;

      // Repo state untouched.
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      const statusFailure = statusIter["failure"] as Record<string, unknown>;
      expect(statusFailure).toMatchObject({ code: "runtime_unavailable" });
      expect(statusPayload["runner"]).toBe("acp");

      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      const runnerLogField = logsPayload["runnerLog"] as Record<string, unknown>;
      expect(runnerLogField["readable"]).toBe(true);
      expect(runnerLogField["content"]).toContain("[acp] runtime_unavailable");
    },
    120_000
  );
});
