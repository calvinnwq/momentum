import { readFile, access } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const tsUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      try {
        await access(fileURLToPath(tsUrl));
        return { url: tsUrl.href, shortCircuit: true };
      } catch {
        // Re-throw the original module resolution error below.
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: stripTypeScriptTypes(source, { mode: "strip" })
    };
  }
  return nextLoad(url, context);
}
