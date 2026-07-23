import fs from "node:fs";
import path from "node:path";

import {
  loadExecutorRegistry,
  parseExecutorModuleConfig,
  type ExecutorRegistryLoadResult,
} from "./registry.js";
import type { Executor } from "./types.js";

export const DAEMON_EXECUTOR_CONFIG_ENV_VAR = "MOMENTUM_EXECUTOR_CONFIG";

export type DaemonExecutorRegistryResolution =
  | { status: "not_configured" }
  | {
      status: "configured";
      source: string;
      configuredNames: ReadonlySet<string>;
      load: () => Promise<ExecutorRegistryLoadResult>;
    }
  | { status: "invalid"; source: string; message: string };

/** Resolve config shape synchronously; module imports remain lazy and async. */
export function resolveDaemonExecutorRegistry(
  env: Record<string, string | undefined>,
  builtIns: readonly Executor[] = [],
): DaemonExecutorRegistryResolution {
  const source = (env[DAEMON_EXECUTOR_CONFIG_ENV_VAR] ?? "").trim();
  if (source.length === 0) return { status: "not_configured" };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (error) {
    return {
      status: "invalid",
      source,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const parsed = parseExecutorModuleConfig(parsedJson);
  if (!parsed.ok) {
    return {
      status: "invalid",
      source,
      message: parsed.diagnostics.map((item) => item.message).join("; "),
    };
  }
  let loaded: Promise<ExecutorRegistryLoadResult> | undefined;
  let loadAttempt = 0;
  return {
    status: "configured",
    source,
    configuredNames: new Set(Object.keys(parsed.config.executors)),
    load: () => {
      if (loaded !== undefined) return loaded;
      const loading = loadExecutorRegistry({
        config: parsed.config,
        configDir: path.dirname(path.resolve(source)),
        builtIns,
        importCacheKey: String((loadAttempt += 1)),
      });
      loaded = loading.then(
        (result) => {
          if (!result.ok) loaded = undefined;
          return result;
        },
        (error: unknown) => {
          loaded = undefined;
          throw error;
        },
      );
      return loaded;
    },
  };
}
