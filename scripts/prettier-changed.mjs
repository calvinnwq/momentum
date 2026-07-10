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

function gitMaybe(commandArgs) {
  const result = run("git", commandArgs);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function isAllZeroSha(value) {
  return /^[0]+$/.test(value);
}

function defaultBranchRefs() {
  return [
    gitMaybe([
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]),
    "origin/main",
    "origin/master",
    "main",
    "master",
    "trunk",
  ].filter((ref, index, refs) => ref && refs.indexOf(ref) === index);
}

function defaultBase() {
  for (const ref of defaultBranchRefs()) {
    const base = gitMaybe(["merge-base", "HEAD", ref]);
    if (base && !isAllZeroSha(base)) {
      return base;
    }
  }

  return undefined;
}

function changedFiles() {
  const files = new Set();
  const configuredBase = explicitBase || envBase;
  const base =
    configuredBase && !isAllZeroSha(configuredBase)
      ? configuredBase
      : defaultBase();

  const addDiffFiles = (range) => {
    for (const file of git([
      "diff",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      range,
    ]).split("\n")) {
      if (file) files.add(file);
    }
  };

  if (base) {
    addDiffFiles(`${base}...HEAD`);
  }

  addDiffFiles("HEAD");

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
