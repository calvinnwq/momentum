import { readFileSync } from "node:fs";

import type { GoalSpecResult } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/;

export function parseGoalSpecFile(
  filePath: string,
  repoOverride?: string,
  runnerOverride?: string
): GoalSpecResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { ok: false, error: `Cannot read goal file: ${filePath}` };
  }
  return parseGoalSpec(content, repoOverride, runnerOverride);
}

export function parseGoalSpec(
  content: string,
  repoOverride?: string,
  runnerOverride?: string
): GoalSpecResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return {
      ok: false,
      error: "Goal file must begin with YAML frontmatter (--- ... ---)"
    };
  }

  const [, fm, body] = match;
  const fields = parseSimpleYaml(fm ?? "");

  const rawTitle = fields["title"];
  if (typeof rawTitle !== "string" || !rawTitle.trim()) {
    return { ok: false, error: "`title` is required in goal frontmatter" };
  }
  const title = rawTitle.trim();

  const rawRepo = fields["repo"];
  const repo =
    repoOverride ??
    (typeof rawRepo === "string" && rawRepo ? rawRepo : undefined);

  const rawRunner = fields["runner"];
  const runner =
    runnerOverride ??
    (typeof rawRunner === "string" && rawRunner ? rawRunner : "fake");

  const rawBranch = fields["branch"];
  let branch: string;
  if (typeof rawBranch === "string" && rawBranch) {
    branch = rawBranch;
  } else {
    const slug = slugify(title);
    if (!slug) {
      return { ok: false, error: "`title` must contain letters or numbers to derive a branch" };
    }
    branch = `momentum/${slug}`;
  }

  const rawMaxIter = fields["max_iterations"];
  if (rawMaxIter !== undefined && typeof rawMaxIter !== "number") {
    return { ok: false, error: "`max_iterations` must be a positive integer" };
  }
  const max_iterations = typeof rawMaxIter === "number" ? rawMaxIter : 1;
  if (!isPositiveInteger(max_iterations)) {
    return { ok: false, error: "`max_iterations` must be a positive integer" };
  }

  const rawVerification = fields["verification"];
  const verificationProvided = rawVerification !== undefined;
  const verification = Array.isArray(rawVerification)
    ? (rawVerification as string[])
    : [];

  const rawTimeout = fields["verification_timeout_sec"];
  if (rawTimeout !== undefined && typeof rawTimeout !== "number") {
    return { ok: false, error: "`verification_timeout_sec` must be a positive integer" };
  }
  const verificationTimeoutProvided = typeof rawTimeout === "number";
  const verification_timeout_sec =
    typeof rawTimeout === "number" ? rawTimeout : 900;
  if (!isPositiveInteger(verification_timeout_sec)) {
    return { ok: false, error: "`verification_timeout_sec` must be a positive integer" };
  }

  const trustedShellValue = fields["trusted_shell"];
  const acpValue = fields["acp"];

  return {
    ok: true,
    spec: {
      title,
      repo,
      runner,
      branch,
      max_iterations,
      verification,
      verification_timeout_sec,
      ...(trustedShellValue !== undefined ? { trusted_shell: trustedShellValue } : {}),
      ...(acpValue !== undefined ? { acp: acpValue } : {}),
      body: (body ?? "").trimEnd()
    },
    rawFrontmatter: {
      runner: rawRunner,
      ...(trustedShellValue !== undefined ? { trusted_shell: trustedShellValue } : {}),
      ...(acpValue !== undefined ? { acp: acpValue } : {}),
      verificationProvided,
      verificationTimeoutProvided
    }
  };
}

type YamlScalar = string | number;
type YamlMapping = { [key: string]: YamlValue };
type YamlValue = YamlScalar | string[] | YamlMapping;
type YamlFields = YamlMapping;

function parseSimpleYaml(yaml: string): YamlFields {
  const lines = yaml.split("\n");
  return parseYamlBlock(lines, 0, 0).value;
}

type ParseFrame = { value: YamlFields; nextIndex: number };

function parseYamlBlock(
  lines: string[],
  startIndex: number,
  baseIndent: number
): ParseFrame {
  const fields: YamlFields = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = leadingIndentWidth(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // Indented content owned by a sibling block we already consumed; skip
      // defensively to avoid an infinite loop.
      i++;
      continue;
    }

    const trimmed = line.slice(indent);
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1);
    const commentStrippedRest = stripInlineComment(rest).trim();

    if (commentStrippedRest === "") {
      const probe = peekNextContentfulLine(lines, i + 1);
      if (probe === null || probe.indent < baseIndent) {
        fields[key] = "";
        i = probe === null ? lines.length : probe.index;
        continue;
      }

      const childIndent = probe.indent;
      const probeBody = probe.line.slice(childIndent);

      if (probeBody.startsWith("- ") || probeBody === "-") {
        const items: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const next = lines[j] ?? "";
          if (!next.trim() || next.trim().startsWith("#")) {
            j++;
            continue;
          }
          const li = leadingIndentWidth(next);
          if (li < childIndent) break;
          if (li > childIndent) {
            // Nested continuation lines inside a list item are not supported;
            // skip them defensively.
            j++;
            continue;
          }
          const body = next.slice(li);
          if (body.startsWith("- ") || body === "-") {
            items.push(
              String(parseYamlScalar(body.replace(/^-\s*/, "").trim()))
            );
            j++;
            continue;
          }
          break;
        }
        fields[key] = items;
        i = j;
      } else if (probe.indent <= baseIndent) {
        fields[key] = "";
        i = probe.index;
      } else {
        const nested = parseYamlBlock(lines, i + 1, childIndent);
        fields[key] = nested.value;
        i = nested.nextIndex;
      }
    } else if (
      commentStrippedRest.startsWith("[") &&
      commentStrippedRest.endsWith("]")
    ) {
      fields[key] = parseYamlInlineArray(commentStrippedRest);
      i++;
    } else {
      fields[key] = parseYamlScalar(rest);
      i++;
    }
  }

  return { value: fields, nextIndex: i };
}

function leadingIndentWidth(line: string): number {
  let n = 0;
  while (n < line.length) {
    const ch = line[n];
    if (ch === " " || ch === "\t") {
      n++;
    } else {
      break;
    }
  }
  return n;
}

function peekNextContentfulLine(
  lines: string[],
  from: number
): { index: number; line: string; indent: number } | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    return { index: i, line, indent: leadingIndentWidth(line) };
  }
  return null;
}

function parseYamlScalar(raw: string): YamlScalar {
  raw = stripInlineComment(raw).trim();
  const n = Number(raw);
  if (!Number.isNaN(n) && raw !== "") return n;
  // Strip optional surrounding quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function stripInlineComment(raw: string): string {
  let quote: string | undefined;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
    } else if (char === quote) {
      quote = undefined;
    } else if (char === "#" && quote === undefined && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
      return raw.slice(0, index);
    }
  }

  return raw;
}

function parseYamlInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];

  const items: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (const char of inner) {
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
    } else if (char === quote) {
      quote = undefined;
    }

    if (char === "," && quote === undefined) {
      items.push(String(parseYamlScalar(current.trim())));
      current = "";
    } else {
      current += char;
    }
  }

  items.push(String(parseYamlScalar(current.trim())));
  return items;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
