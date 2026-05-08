import process from "node:process";

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
  repo?: string;
  runner?: string;
};

const COMMANDS = [
  "momentum goal start <goal.md> --repo <path> --foreground [--runner <profile>] [--json]",
  "momentum status [goal-id] [--json]",
  "momentum handoff <goal-id> [--json]",
  "momentum doctor [--json]"
];

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const parsed = parseFlags(argv);
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
    milestone: "NGX-235 scaffold"
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
  const foreground = parsed.args.includes("--foreground");

  if (!goalPath) {
    return usageError("Missing required <goal.md> for goal start.", parsed, io);
  }

  if (!parsed.repo) {
    return usageError("Missing required --repo <path> for goal start.", parsed, io);
  }

  if (!foreground) {
    return usageError("Missing required --foreground for Milestone 1 goal start.", parsed, io);
  }

  return reservedCommand("goal start", parsed, io, {
    goalPath,
    repo: parsed.repo,
    foreground,
    runner: parsed.runner ?? "fake"
  });
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
  let repo: string | undefined;
  let runner: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--repo") {
      repo = readFlagValue(argv, index, "--repo");
      index += 1;
      continue;
    }

    if (arg === "--runner") {
      runner = readFlagValue(argv, index, "--runner");
      index += 1;
      continue;
    }

    args.push(arg);
  }

  const parsed: ParsedFlags = { args, json };
  if (repo !== undefined) {
    parsed.repo = repo;
  }
  if (runner !== undefined) {
    parsed.runner = runner;
  }

  return parsed;
}

function readFlagValue(argv: string[], index: number, flag: string): string | undefined {
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
    "Milestone 1 scaffold reserves the public CLI shape. Goal parsing, runner execution, status, and handoff behavior land in later NGX-236..NGX-239 issues.",
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
