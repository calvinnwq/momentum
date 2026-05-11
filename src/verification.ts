import { spawnSync } from "node:child_process";
import fs from "node:fs";

export type VerificationCommandResult = {
  command: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  timed_out: boolean;
  succeeded: boolean;
};

export type VerificationErrorCode =
  | "invalid_input"
  | "log_write_failed"
  | "spawn_failed"
  | "command_failed"
  | "command_timed_out"
  | "output_overflow";

const VERIFICATION_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export type VerificationFailure = {
  ok: false;
  code: VerificationErrorCode;
  error: string;
  results: VerificationCommandResult[];
};

export type VerificationSuccess = {
  ok: true;
  results: VerificationCommandResult[];
};

export type VerificationResult = VerificationSuccess | VerificationFailure;

export type VerificationInput = {
  repoPath: string;
  commands: string[];
  timeoutSec: number;
  logPath: string;
};

export function runVerification(input: VerificationInput): VerificationResult {
  const validation = validateInput(input);
  if (!validation.ok) return validation;

  const { repoPath, commands, timeoutSec, logPath } = input;
  const timeoutMs = timeoutSec * 1000;

  let logHandle: number;
  try {
    logHandle = fs.openSync(logPath, "w");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "log_write_failed",
      error: `failed to open verification log ${logPath}: ${detail}`,
      results: []
    };
  }

  const results: VerificationCommandResult[] = [];

  try {
    if (commands.length === 0) {
      writeLine(logHandle, "[verify] no verification commands configured");
      writeLine(logHandle, "[verify] summary: verification skipped");
      return { ok: true, results };
    }

    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index] as string;
      writeLine(logHandle, `[verify] running: ${command}`);
      writeLine(logHandle, `[verify]   cwd: ${repoPath}`);

      const start = Date.now();
      let spawn: ReturnType<typeof spawnSync>;
      try {
        spawn = spawnSync(command, {
          cwd: repoPath,
          shell: true,
          timeout: timeoutMs,
          encoding: "utf-8",
          maxBuffer: VERIFICATION_MAX_BUFFER_BYTES,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        writeLine(logHandle, `[verify]   spawn_error: ${detail}`);
        writeLine(
          logHandle,
          `[verify] summary: verification failed to spawn command ${index + 1}`
        );
        return {
          ok: false,
          code: "spawn_failed",
          error: `failed to spawn verification command ${index + 1} (${command}): ${detail}`,
          results
        };
      }

      const durationMs = Date.now() - start;

      if (spawn.error !== undefined && (spawn.error as NodeJS.ErrnoException).code === "ENOENT") {
        writeLine(logHandle, `[verify]   spawn_error: ${spawn.error.message}`);
        writeLine(
          logHandle,
          `[verify] summary: verification failed to spawn command ${index + 1}`
        );
        return {
          ok: false,
          code: "spawn_failed",
          error: `failed to spawn verification command ${index + 1} (${command}): ${spawn.error.message}`,
          results
        };
      }

      const stdoutText = typeof spawn.stdout === "string" ? spawn.stdout : "";
      const stderrText = typeof spawn.stderr === "string" ? spawn.stderr : "";
      if (stdoutText.length > 0) writeChunk(logHandle, stdoutText);
      if (stderrText.length > 0) writeChunk(logHandle, stderrText);
      ensureTrailingNewline(logHandle, stdoutText, stderrText);

      if (
        spawn.error !== undefined &&
        (spawn.error as NodeJS.ErrnoException).code === "ENOBUFS"
      ) {
        writeLine(
          logHandle,
          `[verify]   output_overflow: stdout or stderr exceeded ${VERIFICATION_MAX_BUFFER_BYTES} bytes`
        );
        writeLine(
          logHandle,
          `[verify] summary: verification output overflowed buffer on command ${index + 1}: ${command}`
        );
        results.push({
          command,
          exit_code: null,
          signal: spawn.signal ?? null,
          duration_ms: durationMs,
          timed_out: false,
          succeeded: false
        });
        return {
          ok: false,
          code: "output_overflow",
          error: `verification command ${index + 1} produced more than ${VERIFICATION_MAX_BUFFER_BYTES} bytes on stdout or stderr (${command}); raise the cap or reduce the command's verbosity.`,
          results
        };
      }

      const timedOut =
        spawn.signal === "SIGTERM" &&
        spawn.error !== undefined &&
        (spawn.error as NodeJS.ErrnoException).code === "ETIMEDOUT";

      const signal = spawn.signal ?? null;
      const exitCode = spawn.status;

      const result: VerificationCommandResult = {
        command,
        exit_code: exitCode,
        signal,
        duration_ms: durationMs,
        timed_out: timedOut,
        succeeded: !timedOut && exitCode === 0
      };
      results.push(result);

      writeLine(logHandle, `[verify]   exit_code: ${formatExit(exitCode)}`);
      if (signal !== null) {
        writeLine(logHandle, `[verify]   signal: ${signal}`);
      }
      writeLine(logHandle, `[verify]   duration_ms: ${durationMs}`);

      if (timedOut) {
        writeLine(logHandle, "[verify]   result: timed_out");
        writeLine(
          logHandle,
          `[verify] summary: verification timed out on command ${index + 1}: ${command}`
        );
        return {
          ok: false,
          code: "command_timed_out",
          error: `verification command ${index + 1} timed out after ${timeoutSec}s: ${command}`,
          results
        };
      }

      if (!result.succeeded) {
        writeLine(logHandle, "[verify]   result: failed");
        writeLine(
          logHandle,
          `[verify] summary: verification failed on command ${index + 1}: ${command}`
        );
        return {
          ok: false,
          code: "command_failed",
          error: `verification command ${index + 1} failed (${command}): exit ${formatExit(exitCode)}`,
          results
        };
      }

      writeLine(logHandle, "[verify]   result: ok");
    }

    writeLine(
      logHandle,
      `[verify] summary: all ${commands.length} verification command(s) passed`
    );
    return { ok: true, results };
  } finally {
    try {
      fs.closeSync(logHandle);
    } catch {
      // ignore close failures
    }
  }
}

function validateInput(input: VerificationInput): VerificationFailure | { ok: true } {
  if (typeof input.repoPath !== "string" || input.repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "repoPath is required.",
      results: []
    };
  }
  if (typeof input.logPath !== "string" || input.logPath.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "logPath is required.",
      results: []
    };
  }
  if (!Number.isInteger(input.timeoutSec) || input.timeoutSec <= 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "timeoutSec must be a positive integer.",
      results: []
    };
  }
  if (!Array.isArray(input.commands)) {
    return {
      ok: false,
      code: "invalid_input",
      error: "commands must be an array of strings.",
      results: []
    };
  }
  for (let index = 0; index < input.commands.length; index += 1) {
    const command = input.commands[index];
    if (typeof command !== "string" || command.trim().length === 0) {
      return {
        ok: false,
        code: "invalid_input",
        error: `commands[${index}] must be a non-empty string.`,
        results: []
      };
    }
  }
  return { ok: true };
}

function writeLine(handle: number, line: string): void {
  fs.writeSync(handle, `${line}\n`);
}

function writeChunk(handle: number, chunk: string): void {
  if (chunk.length > 0) {
    fs.writeSync(handle, chunk);
  }
}

function ensureTrailingNewline(
  handle: number,
  stdout: string,
  stderr: string
): void {
  const last = stderr.length > 0 ? stderr : stdout;
  if (last.length > 0 && !last.endsWith("\n")) {
    fs.writeSync(handle, "\n");
  }
}

function formatExit(exitCode: number | null): string {
  return exitCode === null ? "null" : String(exitCode);
}
