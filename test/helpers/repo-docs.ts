import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, "../..");

export function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

export function repoFileExists(relative: string): boolean {
  return fs.existsSync(path.join(repoRoot, relative));
}

export function listRepoMarkdown(relativeDir: string): string[] {
  const dir = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(
        ...listRepoMarkdown(path.relative(repoRoot, full).split(path.sep).join("/"))
      );
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export function expectSpecSection(spec: string, heading: string): void {
  expect(spec, `SPEC.md should expose ${heading}`).toMatch(
    new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m")
  );
}
