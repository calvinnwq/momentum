#!/usr/bin/env node
import "./suppress-sqlite-experimental-warning.js";

const { runCli } = await import("./cli.js");

const exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env
});

process.exitCode = exitCode;
