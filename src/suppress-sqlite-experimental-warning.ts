import process from "node:process";

const SQLITE_EXPERIMENTAL_WARNING =
  "SQLite is an experimental feature and might change at any time";

type MutableProcessWarning = typeof process & {
  emitWarning: (...args: unknown[]) => void;
};

const mutableProcess = process as MutableProcessWarning;
const emitWarning = mutableProcess.emitWarning.bind(process);

mutableProcess.emitWarning = function emitWarningWithoutSqliteNoise(
  ...args: unknown[]
): void {
  const warning = args[0];
  const typeOrOptions = args[1];
  const type =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : isEmitWarningOptions(typeOrOptions)
        ? typeOrOptions.type
        : undefined;
  const message =
    typeof warning === "string"
      ? warning
      : warning instanceof Error
        ? warning.message
        : undefined;

  if (type === "ExperimentalWarning" && message === SQLITE_EXPERIMENTAL_WARNING) {
    return;
  }

  emitWarning(...args);
};

function isEmitWarningOptions(value: unknown): value is NodeJS.EmitWarningOptions {
  return typeof value === "object" && value !== null;
}
