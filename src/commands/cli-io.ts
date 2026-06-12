import { COMMANDS } from "./help.js";

export type Writer = {
  write(chunk: string): boolean;
};

export type CliIo = {
  stdout: Writer;
  stderr: Writer;
  env?: NodeJS.ProcessEnv;
};

export type JsonPayload = Record<string, unknown>;

export function usageError(
  message: string,
  parsed: { json: boolean },
  io: CliIo
): number {
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

export function renderHelp(): string {
  return [
    "Momentum",
    "",
    "Usage:",
    ...COMMANDS.map((command) => `  ${command}`),
    "",
    "Default goal start enqueues a goal_iteration job for a future worker; pass --foreground to keep the Milestone 1 inline iteration.",
    ""
  ].join("\n");
}

export function writeJson(writer: Writer, payload: JsonPayload): void {
  write(writer, `${JSON.stringify(payload, null, 2)}\n`);
}

export function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}
