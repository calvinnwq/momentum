#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const write = args.includes("--write");
const explicitBaseIndex = args.indexOf("--base");
const explicitBase =
  explicitBaseIndex >= 0 ? args[explicitBaseIndex + 1]?.trim() : undefined;
const envBase = process.env.MOMENTUM_FORMAT_BASE?.trim();
const mode = write ? "--write" : "--check";
const ALWAYS_IGNORED = new Set(["pnpm-lock.yaml"]);

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function git(commandArgs) {
  const result = run("git", commandArgs);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `git ${commandArgs.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function isAllZeroSha(value) {
  return /^[0]+$/.test(value);
}

function changedFiles() {
  const files = new Set();
  const base = explicitBase || envBase;

  if (base && !isAllZeroSha(base)) {
    for (const file of git([
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      `${base}...HEAD`,
    ]).split("\n")) {
      if (file) files.add(file);
    }
  } else {
    for (const file of git([
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      "HEAD",
    ]).split("\n")) {
      if (file) files.add(file);
    }
  }

  for (const file of git(["ls-files", "--others", "--exclude-standard"]).split(
    "\n",
  )) {
    if (file) files.add(file);
  }

  return [...files]
    .filter((file) => !ALWAYS_IGNORED.has(file))
    .filter((file) => !file.startsWith("docs/"))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .sort();
}

const files = changedFiles();
if (files.length === 0) {
  console.log("No changed files to format.");
  process.exit(0);
}

const prettier = run("prettier", [mode, "--ignore-unknown", ...files], {
  stdio: "inherit",
});
process.exit(prettier.status ?? 1);
