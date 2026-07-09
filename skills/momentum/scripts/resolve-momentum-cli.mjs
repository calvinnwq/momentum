#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = { cwd: process.cwd(), json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing required value for --cwd.");
      out.cwd = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function splitCommand(input) {
  const parts = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next && (/\s/.test(next) || next === "'" || next === "\"" || next === "\\")) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (quote) throw new Error(`Unclosed quote in MOMENTUM_CLI.`);
  if (current) parts.push(current);
  return parts;
}

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findOnPath(command, envPath = process.env.PATH ?? "") {
  const pathExt =
    process.platform === "win32"
      ? path.win32.extname(command)
        ? [""]
        : ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];

  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function commandExists(command) {
  if (command.includes("/") || command.includes("\\")) {
    return isExecutableFile(path.resolve(command));
  }
  return findOnPath(command) !== null;
}

function isMomentumCheckout(dir) {
  const packageJson = path.join(dir, "package.json");
  const architecture = path.join(dir, "ARCHITECTURE.md");
  if (!fs.existsSync(packageJson) || !fs.existsSync(architecture)) return false;

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    return parsed?.name === "@calvinnwq/momentum";
  } catch {
    return false;
  }
}

function findMomentumCheckout(start) {
  let current = path.resolve(start);
  while (true) {
    if (isMomentumCheckout(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function success(source, argv, extra = {}) {
  return {
    ok: true,
    source,
    command: argv.map(shellQuote).join(" "),
    argv,
    ...extra
  };
}

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function resolveCheckout(checkout) {
  const distIndex = path.join(checkout, "dist", "index.js");
  if (!fs.existsSync(distIndex)) {
    return failure(
      "dev_checkout_not_built",
      `Momentum checkout found at ${checkout}, but dist/index.js is missing. Run pnpm build from that checkout before retrying.`,
      { checkout }
    );
  }
  return success("dev-checkout", ["node", distIndex], { checkout });
}

function resolveMomentumCli(cwd) {
  const envCommand = process.env.MOMENTUM_CLI?.trim();
  if (envCommand) {
    let argv;
    try {
      argv = splitCommand(envCommand);
    } catch (error) {
      return failure("invalid_env_cli", error.message);
    }
    if (argv.length === 0) return failure("invalid_env_cli", "MOMENTUM_CLI is empty.");
    if (!commandExists(argv[0])) {
      return failure(
        "env_cli_not_found",
        `MOMENTUM_CLI command is not executable or on PATH: ${argv[0]}`
      );
    }
    return success("env", argv);
  }

  const pathCommand = findOnPath("momentum");
  if (pathCommand) return success("path", ["momentum"], { resolvedPath: pathCommand });

  const cwdCheckout = findMomentumCheckout(cwd);
  if (cwdCheckout) return resolveCheckout(cwdCheckout);

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledCheckout = findMomentumCheckout(scriptDir);
  if (bundledCheckout) {
    return resolveCheckout(bundledCheckout);
  }

  return failure(
    "cli_not_found",
    "Could not resolve Momentum CLI. Set MOMENTUM_CLI, install momentum on PATH, or run from a built Momentum checkout."
  );
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    const payload = failure("usage_error", error.message);
    process.stderr.write(`${JSON.stringify(payload, null, 2)}${os.EOL}`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    process.stdout.write(
      [
        "Usage: resolve-momentum-cli.mjs [--cwd <dir>] [--json]",
        "",
        "Resolves Momentum CLI as MOMENTUM_CLI, momentum on PATH, or a built dev checkout."
      ].join(os.EOL) + os.EOL
    );
    return;
  }

  const result = resolveMomentumCli(args.cwd);
  const stream = result.ok ? process.stdout : process.stderr;
  if (args.json) {
    stream.write(`${JSON.stringify(result, null, 2)}${os.EOL}`);
  } else if (result.ok) {
    stream.write(`${result.command}${os.EOL}`);
  } else {
    stream.write(`${result.message}${os.EOL}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

main();
