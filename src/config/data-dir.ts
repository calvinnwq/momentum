import os from "node:os";
import path from "node:path";

export type DataDirOptions = {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolves the Momentum data directory using the priority chain:
 *   1. explicit --data-dir argument
 *   2. MOMENTUM_HOME environment variable
 *   3. ~/.momentum
 */
export function resolveDataDir(options: DataDirOptions = {}): string {
  if (options.dataDir) return options.dataDir;

  const env = options.env ?? process.env;
  const momentumHome = env["MOMENTUM_HOME"];
  if (momentumHome) return momentumHome;

  return path.join(os.homedir(), ".momentum");
}
