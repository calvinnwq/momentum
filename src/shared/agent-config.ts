import { resolveCommandModelAlias } from "../core/model-aliases.js";

export const PORTABLE_AGENT_CONFIG_FIELDS = [
  "harness",
  "model",
  "effort",
] as const;

export type PortableAgentConfig = Partial<
  Record<(typeof PORTABLE_AGENT_CONFIG_FIELDS)[number], string>
>;

/** Merge definition defaults with a sparse run override in canonical field order. */
export function mergePortableAgentConfig(
  defaults: PortableAgentConfig | undefined,
  override: PortableAgentConfig | undefined,
): PortableAgentConfig {
  const merged: PortableAgentConfig = {};
  for (const field of PORTABLE_AGENT_CONFIG_FIELDS) {
    const value = override?.[field] ?? defaults?.[field];
    if (value !== undefined) merged[field] = value.trim();
  }
  if (merged.model !== undefined) {
    merged.model = resolveCommandModelAlias(merged.harness, merged.model);
  }
  return merged;
}
