export type ModelAliasEntry = readonly [alias: string, canonical: string];

function aliasMap(
  entries: readonly ModelAliasEntry[]
): ReadonlyMap<string, string> {
  return new Map(
    entries.map(([alias, canonical]) => [alias.toLowerCase(), canonical])
  );
}

export const OPENAI_MODEL_IDS = [
  "gpt-5.1",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-fast",
  "gpt-5.4-mini",
  "gpt-5.4-mini-fast",
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.5-pro"
] as const;

function codexOpenAiAliases(
  modelIds: readonly string[]
): ModelAliasEntry[] {
  const entries: ModelAliasEntry[] = [];
  for (const modelId of modelIds) {
    entries.push([modelId, modelId], [`openai/${modelId}`, modelId]);
  }
  return entries;
}

function opencodeOpenAiAliases(
  modelIds: readonly string[]
): ModelAliasEntry[] {
  const entries: ModelAliasEntry[] = [];
  for (const modelId of modelIds) {
    entries.push(
      [modelId, `openai/${modelId}`],
      [`openai/${modelId}`, `openai/${modelId}`]
    );
  }
  return entries;
}

export const CLAUDE_MODEL_ALIASES = [
  ["opus", "claude-opus-4-8"],
  ["opus-4.8", "claude-opus-4-8"],
  ["opus-4-8", "claude-opus-4-8"],
  ["claude-opus-4.8", "claude-opus-4-8"],
  ["claude-opus-4-8", "claude-opus-4-8"],
  ["sonnet", "claude-sonnet-4-6"],
  ["sonnet-4.6", "claude-sonnet-4-6"],
  ["sonnet-4-6", "claude-sonnet-4-6"],
  ["claude-sonnet-4.6", "claude-sonnet-4-6"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"]
] as const satisfies readonly ModelAliasEntry[];

export const CODEX_MODEL_ALIASES = [
  ["spark", "gpt-5.3-codex-spark"],
  ["codex-spark", "gpt-5.3-codex-spark"],
  ["gpt-5.3-spark", "gpt-5.3-codex-spark"],
  ["gpt-5.3-codex", "gpt-5.3-codex-spark"],
  ...codexOpenAiAliases(OPENAI_MODEL_IDS)
] as const satisfies readonly ModelAliasEntry[];

export const OPENCODE_MODEL_ALIASES = [
  ...opencodeOpenAiAliases(OPENAI_MODEL_IDS),
  ["glm-5.2", "opencode-go/glm-5.2"],
  ["opencode-go/glm-5.2", "opencode-go/glm-5.2"],
  ["qwen3.7-plus", "opencode-go/qwen3.7-plus"],
  ["opencode-go/qwen3.7-plus", "opencode-go/qwen3.7-plus"],
  ["qwen3.7-max", "opencode-go/qwen3.7-max"],
  ["opencode-go/qwen3.7-max", "opencode-go/qwen3.7-max"]
] as const satisfies readonly ModelAliasEntry[];

/**
 * Provider-qualified command model aliases shared by route/config surfaces.
 *
 * This is intentionally not a supported-model enum. Unknown model strings remain
 * free-form so newer provider models and repo-local wrappers can be used before
 * Momentum knows about them. Entries here only cover aliases where Momentum
 * already knows the command-ready form for a supported harness surface.
 */
export const MODEL_ALIASES_BY_HARNESS: ReadonlyMap<
  string,
  ReadonlyMap<string, string>
> = new Map([
  ["claude", aliasMap(CLAUDE_MODEL_ALIASES)],
  ["codex", aliasMap(CODEX_MODEL_ALIASES)],
  ["opencode", aliasMap(OPENCODE_MODEL_ALIASES)]
]);

/**
 * Normalize a provider-specific model alias into the exact command-ready string
 * the selected harness should receive. Non-agent harnesses, unknown harnesses,
 * and unknown model strings pass through unchanged.
 */
export function resolveCommandModelAlias(
  harness: string | undefined,
  model: string
): string {
  if (harness === undefined) {
    return model;
  }
  const harnessAliases = MODEL_ALIASES_BY_HARNESS.get(harness.toLowerCase());
  return harnessAliases?.get(model.toLowerCase()) ?? model;
}
