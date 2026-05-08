import process from "node:process";
import { initGoal, type GoalInitOptions } from "./goal-init.js";
import type { DataDirOptions } from "./data-dir.js";

export const VERSION = "0.0.0";

type Writer = {
  write(chunk: string): boolean;
};

export type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

type JsonPayload = Record<string, unknown>;

type ParsedFlags = {
  args: string[];
  json: boolean;
  foreground: boolean;
  repo?: string;
  runner?: string;
  dataDir?: string;
  error?: string;
};

const COMMANDS = [
  "momentum goal start <goal.md> [--repo <path>] --foreground [--runner <profile>] [--data-dir <path>] [--json]",
  "momentum status [goal-id] [--json]",
  "momentum handoff <goal-id> [--json]",
  "momentum doctor [--json]"
];

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const parsed = parseFlags(argv);
  if (parsed.error) {
    return usageError(parsed.error, parsed, io);
  }

  const [command, subcommand] = parsed.args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    write(io.stdout, renderHelp());
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    write(io.stdout, `${VERSION}\n`);
    return 0;
  }

  if (command === "doctor") {
    return doctor(parsed, io);
  }

  if (command === "goal" && subcommand === "start") {
    return goalStart(parsed, io);
  }

  if (command === "status") {
    return reservedCommand("status", parsed, io, {
      goalId: parsed.args[1] ?? null
    });
  }

  if (command === "handoff") {
    const goalId = parsed.args[1];
    if (!goalId) {
      return usageError("Missing required <goal-id> for handoff.", parsed, io);
    }

    return reservedCommand("handoff", parsed, io, { goalId });
  }

  return usageError(`Unknown command: ${command}`, parsed, io);
}

function doctor(parsed: ParsedFlags, io: CliIo): number {
  const payload = {
    ok: true,
    command: "doctor",
    version: VERSION,
    node: process.version,
    platform: process.platform,
    milestone: "NGX-236 goal-init"
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    "Momentum doctor: ok",
    `version: ${payload.version}`,
    `node: ${payload.node}`,
    `platform: ${payload.platform}`,
    `scope: ${payload.milestone}`,
    ""
  ].join("\n"));
  return 0;
}

function goalStart(parsed: ParsedFlags, io: CliIo): number {
  const goalPath = parsed.args[2];

  if (!goalPath) {
    return usageError("Missing required <goal.md> for goal start.", parsed, io);
  }

  if (parsed.args.length > 3) {
    return usageError(`Unexpected argument for goal start: ${parsed.args[3]}`, parsed, io);
  }

  if (!parsed.foreground) {
    return usageError("Missing required --foreground for Milestone 1 goal start.", parsed, io);
  }

  const dataDirOptions: DataDirOptions = {};
  if (io.env !== undefined) dataDirOptions.env = io.env;
  if (parsed.dataDir !== undefined) dataDirOptions.dataDir = parsed.dataDir;

  const initOptions: GoalInitOptions = { goalPath };
  if (parsed.repo !== undefined) initOptions.repoOverride = parsed.repo;
  if (parsed.runner !== undefined) initOptions.runnerOverride = parsed.runner;
  initOptions.dataDirOptions = dataDirOptions;

  const result = initGoal(initOptions);

  if (!result.ok) {
    const payload = {
      ok: false,
      command: "goal start",
      code: "init_error",
      message: result.error
    };
    if (parsed.json) {
      writeJson(io.stderr, payload);
      return 1;
    }
    write(io.stderr, `${result.error}\n`);
    return 1;
  }

  const payload = {
    ok: true,
    command: "goal start",
    goalId: result.goalId,
    jobId: result.jobId,
    title: result.spec.title,
    dataDir: result.dataDir,
    artifactDir: result.artifactPaths.goalDir,
    state: "initialized",
    resumed: result.resumed
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 0;
  }

  write(io.stdout, [
    `${result.resumed ? "Goal resumed" : "Goal initialized"}: ${result.goalId}`,
    `Title: ${result.spec.title}`,
    `Artifact dir: ${result.artifactPaths.goalDir}`,
    ""
  ].join("\n"));
  return 0;
}

function reservedCommand(
  command: string,
  parsed: ParsedFlags,
  io: CliIo,
  details: JsonPayload
): number {
  const payload = {
    ok: false,
    command,
    code: "not_implemented",
    message: `${command} is reserved by NGX-235 and will be implemented in a later Milestone 1 issue.`,
    ...details
  };

  if (parsed.json) {
    writeJson(io.stdout, payload);
    return 1;
  }

  write(io.stderr, `${payload.message}\n`);
  return 1;
}

function usageError(message: string, parsed: ParsedFlags, io: CliIo): number {
  const payload = {
    ok: false,
    code: "usage_error",
    message,
    commands: COMMANDS
  };

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 2;
  }

  write(io.stderr, `${message}\n\n${renderHelp()}`);
  return 2;
}

function parseFlags(argv: string[]): ParsedFlags {
  const args: string[] = [];
  let json = false;
  let foreground = false;
  let repo: string | undefined;
  let runner: string | undefined;
  let dataDir: string | undefined;
  let error: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--foreground") {
      foreground = true;
      continue;
    }

    if (arg === "--repo") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --repo.";
      } else {
        repo = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--runner") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --runner.";
      } else {
        runner = value;
        index += 1;
      }
      continue;
    }

    if (arg === "--data-dir") {
      const value = readFlagValue(argv, index);
      if (value === undefined) {
        error ??= "Missing required value for --data-dir.";
      } else {
        dataDir = value;
        index += 1;
      }
      continue;
    }

    args.push(arg);
  }

  const parsed: ParsedFlags = { args, json, foreground };
  if (repo !== undefined) parsed.repo = repo;
  if (runner !== undefined) parsed.runner = runner;
  if (dataDir !== undefined) parsed.dataDir = dataDir;
  if (error !== undefined) parsed.error = error;

  return parsed;
}

function readFlagValue(argv: string[], index: number): string | undefined {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    return undefined;
  }

  return value;
}

function renderHelp(): string {
  return [
    "Momentum",
    "",
    "Usage:",
    ...COMMANDS.map((command) => `  ${command}`),
    "",
    "Milestone 1 supports Goal parsing and data/artifact initialization. Runner execution, status, and handoff behavior land in later NGX-237..NGX-239 issues.",
    ""
  ].join("\n");
}

function writeJson(writer: Writer, payload: JsonPayload): void {
  write(writer, `${JSON.stringify(payload, null, 2)}\n`);
}

function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}

function defaultIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}
