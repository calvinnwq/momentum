import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import type { Executor } from "./types.js";
import { validateExecutorConfigSchema } from "./config-schema.js";

export type ExecutorRegistry = ReadonlyMap<string, Executor>;

export type ExecutorModuleConfig = {
  executors: Readonly<Record<string, string>>;
};

export type ExecutorRegistrationDiagnostic = {
  code:
    | "executor_config_invalid"
    | "executor_module_unavailable"
    | "executor_module_invalid";
  executor: string;
  moduleSpecifier: string | null;
  message: string;
};

export type ExecutorRegistryLoadResult =
  | { ok: true; registry: ExecutorRegistry }
  | {
      ok: false;
      registry: ExecutorRegistry;
      diagnostics: readonly ExecutorRegistrationDiagnostic[];
    };

export function parseExecutorModuleConfig(
  value: unknown,
):
  | { ok: true; config: ExecutorModuleConfig }
  | { ok: false; diagnostics: readonly ExecutorRegistrationDiagnostic[] } {
  if (!isPlainObject(value) || !isPlainObject(value["executors"])) {
    return configFailure(
      "Executor config must be an object with an executors map.",
    );
  }
  const rootKeys = Object.keys(value);
  if (rootKeys.length !== 1 || rootKeys[0] !== "executors") {
    return configFailure(
      "Executor config supports only the top-level executors key.",
    );
  }
  const executors: Record<string, string> = {};
  const diagnostics: ExecutorRegistrationDiagnostic[] = [];
  for (const [name, specifier] of Object.entries(value["executors"])) {
    if (!isExecutorName(name)) {
      diagnostics.push({
        code: "executor_config_invalid",
        executor: name,
        moduleSpecifier: null,
        message: `Executor name ${JSON.stringify(name)} must be a non-empty stable identifier.`,
      });
      continue;
    }
    if (typeof specifier !== "string" || specifier.trim().length === 0) {
      diagnostics.push({
        code: "executor_config_invalid",
        executor: name,
        moduleSpecifier: null,
        message: `Executor ${name} module specifier must be a non-empty string.`,
      });
      continue;
    }
    executors[name] = specifier.trim();
  }
  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, config: { executors } };
}

/** Register built-ins and imported modules through one runtime contract guard. */
export function registerExecutor(
  registry: Map<string, Executor>,
  name: string,
  value: unknown,
  moduleSpecifier: string | null = null,
): ExecutorRegistrationDiagnostic | null {
  if (!isExecutorName(name)) {
    return {
      code: "executor_config_invalid",
      executor: name,
      moduleSpecifier,
      message: `Executor name ${JSON.stringify(name)} must be a non-empty stable identifier.`,
    };
  }
  if (!isObjectLike(value) || value["name"] !== name) {
    return invalidModule(
      name,
      moduleSpecifier,
      `Executor export must declare name ${JSON.stringify(name)}.`,
    );
  }
  if (!validateExecutorConfigSchema(value["configSchema"])) {
    return invalidModule(
      name,
      moduleSpecifier,
      "Executor export must declare a valid strict object configSchema.",
    );
  }
  if (typeof value["tick"] !== "function") {
    return invalidModule(
      name,
      moduleSpecifier,
      "Executor export must implement tick(context).",
    );
  }
  if (registry.has(name)) {
    return invalidModule(
      name,
      moduleSpecifier,
      `Executor ${name} is registered more than once.`,
    );
  }
  registry.set(name, value as unknown as Executor);
  return null;
}

export async function loadExecutorRegistry(input: {
  config: ExecutorModuleConfig;
  configDir: string;
  builtIns?: readonly Executor[];
  importModule?: (specifier: string) => Promise<unknown>;
}): Promise<ExecutorRegistryLoadResult> {
  const registry = new Map<string, Executor>();
  const builtInNames = new Set<string>();
  const diagnostics: ExecutorRegistrationDiagnostic[] = [];
  for (const executor of input.builtIns ?? []) {
    const diagnostic = registerExecutor(registry, executor.name, executor);
    if (diagnostic !== null) diagnostics.push(diagnostic);
    else builtInNames.add(executor.name);
  }
  const importModule = input.importModule ?? ((specifier) => import(specifier));
  for (const [name, configuredSpecifier] of Object.entries(
    input.config.executors,
  )) {
    // An explicit entry owns this durable name even when resolution or import
    // fails. Remove only a known built-in before fallible discovery so a broken
    // override cannot silently execute the built-in implementation instead.
    if (builtInNames.has(name)) registry.delete(name);
    let specifier: string;
    try {
      specifier =
        input.importModule === undefined
          ? resolveModuleSpecifier(configuredSpecifier, input.configDir)
          : configuredSpecifier;
    } catch (error) {
      diagnostics.push({
        code: "executor_module_unavailable",
        executor: name,
        moduleSpecifier: configuredSpecifier,
        message: `Could not resolve executor ${name} from ${configuredSpecifier}: ${errorMessage(error)}`,
      });
      continue;
    }
    let moduleNamespace: unknown;
    try {
      moduleNamespace = await importModule(specifier);
    } catch (error) {
      diagnostics.push({
        code: "executor_module_unavailable",
        executor: name,
        moduleSpecifier: configuredSpecifier,
        message: `Could not import executor ${name} from ${configuredSpecifier}: ${errorMessage(error)}`,
      });
      continue;
    }
    try {
      const exported = executorExport(moduleNamespace);
      const diagnostic = registerExecutor(
        registry,
        name,
        exported,
        configuredSpecifier,
      );
      if (diagnostic !== null) diagnostics.push(diagnostic);
    } catch (error) {
      diagnostics.push(
        invalidModule(
          name,
          configuredSpecifier,
          `Could not inspect executor ${name} from ${configuredSpecifier}: ${errorMessage(error)}`,
        ),
      );
    }
  }
  return diagnostics.length > 0
    ? { ok: false, registry, diagnostics }
    : { ok: true, registry };
}

export function resolveRegisteredExecutor(
  registry: ExecutorRegistry,
  name: string,
): Executor | undefined {
  return registry.get(name);
}

function executorExport(namespace: unknown): unknown {
  if (!isPlainObject(namespace)) return undefined;
  // CommonJS named exports arrive as both `executor` and a `default` wrapper
  // containing the whole module.exports object. Prefer the explicit named form.
  if (namespace["executor"] !== undefined) return namespace["executor"];
  const defaultExport = namespace["default"];
  if (isPlainObject(defaultExport)) {
    return (
      defaultExport["executor"] ?? defaultExport["default"] ?? defaultExport
    );
  }
  return defaultExport;
}

function resolveModuleSpecifier(specifier: string, configDir: string): string {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    return pathToFileURL(path.resolve(configDir, specifier)).href;
  }
  return pathToFileURL(resolveEsmPackageSpecifier(specifier, configDir)).href;
}

function resolveEsmPackageSpecifier(
  specifier: string,
  configDir: string,
): string {
  const { packageName, subpath } = splitPackageSpecifier(specifier);
  let searchDir = path.resolve(configDir);
  let packageDir: string | undefined;
  while (true) {
    const candidate = path.join(searchDir, "node_modules", packageName);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      packageDir = candidate;
      break;
    }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }
  if (packageDir === undefined) {
    throw new Error(
      `Cannot find package ${JSON.stringify(packageName)} from ${configDir}`,
    );
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as unknown;
  if (!isPlainObject(manifest)) {
    throw new Error(
      `Package ${packageName} has an invalid package.json object.`,
    );
  }
  const exportsField = manifest["exports"];
  const usesLegacyResolution = exportsField === undefined;
  let target: string | undefined;
  if (exportsField !== undefined) {
    const resolvedTarget = resolvePackageExport(exportsField, subpath);
    if (typeof resolvedTarget !== "string") {
      throw new Error(`Package ${packageName} does not export ${subpath}.`);
    }
    target = resolvedTarget;
  } else if (subpath !== ".") {
    target = `./${subpath.slice(2)}`;
  } else {
    const entry = manifest["main"] ?? "index.js";
    if (typeof entry !== "string") {
      throw new Error(
        `Package ${packageName} has no string module or main entry.`,
      );
    }
    target = entry.startsWith("./") ? entry : `./${entry}`;
  }
  if (!target.startsWith("./")) {
    throw new Error(
      `Package ${packageName} export target must be package-relative.`,
    );
  }
  const unresolved = path.resolve(packageDir, target);
  const resolved = usesLegacyResolution
    ? resolveLegacyPackageTarget(unresolved)
    : unresolved;
  const relative = path.relative(packageDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Package ${packageName} export target escapes its package root.`,
    );
  }
  return resolved;
}

function resolveLegacyPackageTarget(
  candidate: string,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(candidate)) {
    throw new Error(`Legacy package target cycle: ${candidate}`);
  }
  seen.add(candidate);
  if (isFile(candidate)) return candidate;
  for (const extension of [".js", ".json", ".node"]) {
    const withExtension = `${candidate}${extension}`;
    if (isFile(withExtension)) return withExtension;
  }
  if (isDirectory(candidate)) {
    const manifestPath = path.join(candidate, "package.json");
    if (isFile(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          main?: unknown;
        } | null;
        if (typeof manifest?.main === "string") {
          const nested = path.resolve(candidate, manifest.main);
          if (nested !== candidate)
            return resolveLegacyPackageTarget(nested, seen);
        }
      } catch {
        // Fall through to legacy index probing.
      }
    }
    for (const extension of [".js", ".json", ".node"]) {
      const index = path.join(candidate, `index${extension}`);
      if (isFile(index)) return index;
    }
  }
  throw new Error(`Legacy package target does not exist: ${candidate}`);
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function splitPackageSpecifier(specifier: string): {
  packageName: string;
  subpath: string;
} {
  const parts = specifier.split("/");
  const packageParts = specifier.startsWith("@")
    ? parts.slice(0, 2)
    : parts.slice(0, 1);
  const packageName = packageParts.join("/");
  const remainder = parts.slice(packageParts.length).join("/");
  if (
    packageName.length === 0 ||
    (specifier.startsWith("@") && packageParts.length < 2)
  ) {
    throw new Error(`Invalid package specifier: ${specifier}`);
  }
  return {
    packageName,
    subpath: remainder.length === 0 ? "." : `./${remainder}`,
  };
}

function resolvePackageExport(
  value: unknown,
  subpath: string,
): string | null | undefined {
  if (typeof value === "string")
    return subpath === "." && isValidPackageExportTarget(value)
      ? value
      : undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolvePackageExport(item, subpath);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const subpathKeys = Object.keys(value).filter((key) => key.startsWith("."));
  if (subpathKeys.length > 0) {
    if (Object.prototype.hasOwnProperty.call(value, subpath)) {
      // An exact null or conditionless entry explicitly blocks this subpath;
      // never fall through to a broader wildcard export.
      return resolveConditionalExport(value[subpath]);
    }
    const selected = subpathKeys
      .filter((key) => key.includes("*"))
      .map((pattern) => ({
        pattern,
        wildcard: matchExportPattern(pattern, subpath),
      }))
      .filter(
        (candidate): candidate is { pattern: string; wildcard: string } =>
          candidate.wildcard !== undefined,
      )
      .sort(comparePackageExportPatterns)[0];
    if (selected === undefined) return undefined;
    const target = resolveConditionalExport(value[selected.pattern]);
    return typeof target === "string"
      ? target.replaceAll("*", selected.wildcard)
      : target;
  }
  return subpath === "." ? resolveConditionalExport(value) : undefined;
}

function comparePackageExportPatterns(
  left: { pattern: string },
  right: { pattern: string },
): number {
  const leftPrefixLength = left.pattern.indexOf("*");
  const rightPrefixLength = right.pattern.indexOf("*");
  return (
    rightPrefixLength - leftPrefixLength ||
    right.pattern.length - left.pattern.length
  );
}

function matchExportPattern(
  pattern: string,
  subpath: string,
): string | undefined {
  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix))
    return undefined;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

function resolveConditionalExport(value: unknown): string | null | undefined {
  if (typeof value === "string")
    return isValidPackageExportTarget(value) ? value : undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = resolveConditionalExport(item);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [condition, target] of Object.entries(value)) {
    if (
      condition === "import" ||
      condition === "node-addons" ||
      condition === "node" ||
      condition === "default"
    ) {
      const resolved = resolveConditionalExport(target);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

function isValidPackageExportTarget(target: string): boolean {
  if (!target.startsWith("./")) return false;
  const segments = target.slice(2).split(/[\\/]/u);
  return !segments.some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    const normalized = decoded.toLowerCase();
    return (
      normalized === "." || normalized === ".." || normalized === "node_modules"
    );
  });
}

function isExecutorName(value: string): boolean {
  return value.trim() === value && /^[a-z0-9][a-z0-9._/-]*$/u.test(value);
}

function configFailure(message: string): {
  ok: false;
  diagnostics: readonly ExecutorRegistrationDiagnostic[];
} {
  return {
    ok: false,
    diagnostics: [
      {
        code: "executor_config_invalid",
        executor: "",
        moduleSpecifier: null,
        message,
      },
    ],
  };
}

function invalidModule(
  executor: string,
  moduleSpecifier: string | null,
  message: string,
): ExecutorRegistrationDiagnostic {
  return {
    code: "executor_module_invalid",
    executor,
    moduleSpecifier,
    message,
  };
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message;
    }
  } catch {
    // Hostile proxies can throw even during instanceof/property inspection.
  }
  try {
    return String(error);
  } catch {
    return "uninspectable thrown value";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}
