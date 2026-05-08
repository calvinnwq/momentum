#!/usr/bin/env node
import { runCli } from "./cli.js";

const exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env
});

process.exitCode = exitCode;
