import { readFileSync } from "node:fs";

export type GoalSpec = {
  title: string;
  repo: string | undefined;
  runner: string;
  branch: string;
  max_iterations: number;
  verification: string[];
  verification_timeout_sec: number;
  body: string;
};

export type GoalSpecError = { ok: false; error: string };
export type GoalSpecSuccess = { ok: true; spec: GoalSpec };
export type GoalSpecResult = GoalSpecError | GoalSpecSuccess;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/;

export function parseGoalSpecFile(
  filePath: string,
  repoOverride?: string
): GoalSpecResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { ok: false, error: `Cannot read goal file: ${filePath}` };
  }
  return parseGoalSpec(content, repoOverride);
}

export function parseGoalSpec(
  content: string,
  repoOverride?: string
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
  const runner = typeof rawRunner === "string" && rawRunner ? rawRunner : "fake";

  const rawBranch = fields["branch"];
  const branch =
    typeof rawBranch === "string" && rawBranch
      ? rawBranch
      : `momentum/${slugify(title)}`;

  const rawMaxIter = fields["max_iterations"];
  const max_iterations = typeof rawMaxIter === "number" ? rawMaxIter : 1;

  const rawVerification = fields["verification"];
  const verification = Array.isArray(rawVerification)
    ? (rawVerification as string[])
    : [];

  const rawTimeout = fields["verification_timeout_sec"];
  const verification_timeout_sec =
    typeof rawTimeout === "number" ? rawTimeout : 900;

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
      body: (body ?? "").trimEnd()
    }
  };
}

type YamlScalar = string | number;
type YamlValue = YamlScalar | string[];
type YamlFields = Record<string, YamlValue>;

function parseSimpleYaml(yaml: string): YamlFields {
  const fields: YamlFields = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === "") {
      // Possibly a list
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (/^\s*-\s/.test(next)) {
          items.push(next.replace(/^\s*-\s*/, "").trim());
          i++;
        } else {
          break;
        }
      }
      fields[key] = items;
    } else {
      fields[key] = parseYamlScalar(rest);
      i++;
    }
  }

  return fields;
}

function parseYamlScalar(raw: string): YamlScalar {
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

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
