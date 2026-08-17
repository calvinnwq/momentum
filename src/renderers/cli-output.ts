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

/**
 * Contract version for JSON envelopes that carry tracker-owned keys renamed
 * in the source -> tracker rename (for example `trackerItemId`,
 * `trackerItems`, and the `adapter` filter key).
 *
 * Version 1 is the legacy, unversioned source-keyed shape, which never
 * carried this marker. Version 2 is the tracker-keyed shape, so machine
 * consumers distinguish the two shapes by the marker's presence and value.
 */
export const TRACKER_CONTRACT_SCHEMA_VERSION = 2;

export function usageError(
  message: string,
  parsed: { json: boolean },
  io: CliIo,
): number {
  const payload = {
    ok: false,
    code: "usage_error",
    message,
    commands: COMMANDS,
  };

  if (parsed.json) {
    writeJson(io.stderr, payload);
    return 2;
  }

  write(io.stderr, `${message}\n\n${renderHelp()}`);
  return 2;
}

export function emitHelp(io: CliIo): number {
  write(io.stdout, renderHelp());
  return 0;
}

export function renderHelp(): string {
  return [
    "Momentum",
    "",
    "Usage:",
    ...COMMANDS.map((command) => `  ${command}`),
    "",
  ].join("\n");
}

export function writeJson(writer: Writer, payload: JsonPayload): void {
  write(writer, `${JSON.stringify(payload, null, 2)}\n`);
}

export function write(writer: Writer, chunk: string): void {
  writer.write(chunk);
}
