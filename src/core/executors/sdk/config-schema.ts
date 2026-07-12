import type {
  ExecutorConfigSchema,
  ExecutorConfigValueSchema,
} from "./types.js";

export type ExecutorConfigValidationIssue = {
  path: string;
  message: string;
};

export type ExecutorConfigValidationResult =
  | { ok: true }
  | { ok: false; issues: readonly ExecutorConfigValidationIssue[] };

/** Validate portable step intent against an executor's declared strict schema. */
export function validateExecutorConfig(
  value: unknown,
  schema: ExecutorConfigSchema,
): ExecutorConfigValidationResult {
  const issues: ExecutorConfigValidationIssue[] = [];
  validateValue(value, schema, "config", issues);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** Runtime validation for schemas exported by trusted-but-untyped JS modules. */
export function validateExecutorConfigSchema(
  value: unknown,
): value is ExecutorConfigSchema {
  return validateSchemaNode(value, true, new Set());
}

function validateValue(
  value: unknown,
  schema: ExecutorConfigValueSchema,
  path: string,
  issues: ExecutorConfigValidationIssue[],
): void {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        issue(issues, path, "must be a string");
        return;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        issue(
          issues,
          path,
          `must contain at least ${schema.minLength} characters`,
        );
      }
      if (schema.enum !== undefined && !schema.enum.includes(value)) {
        issue(issues, path, `must be one of: ${schema.enum.join(", ")}`);
      }
      if (schema.pattern !== undefined) {
        try {
          if (!new RegExp(schema.pattern, "u").test(value)) {
            issue(issues, path, `must match ${schema.pattern}`);
          }
        } catch {
          issue(issues, path, "uses an invalid schema pattern");
        }
      }
      return;
    }
    case "integer":
    case "number": {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isInteger(value))
      ) {
        issue(issues, path, `must be a finite ${schema.type}`);
        return;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        issue(issues, path, `must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        issue(issues, path, `must be at most ${schema.maximum}`);
      }
      if (
        schema.multipleOf !== undefined &&
        !isNumericMultiple(value, schema.multipleOf)
      ) {
        issue(issues, path, `must be a multiple of ${schema.multipleOf}`);
      }
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") issue(issues, path, "must be a boolean");
      return;
    case "array":
      if (!Array.isArray(value)) {
        issue(issues, path, "must be an array");
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        issue(issues, path, `must contain at least ${schema.minItems} items`);
      }
      value.forEach((item, index) =>
        validateValue(item, schema.items, `${path}[${index}]`, issues),
      );
      return;
    case "object":
      if (!isPlainObject(value)) {
        issue(issues, path, "must be an object");
        return;
      }
      for (const required of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, required)) {
          issue(issues, `${path}.${required}`, "is required");
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          issue(issues, `${path}.${key}`, "is not supported");
          continue;
        }
        const childSchema = schema.properties[key];
        if (childSchema === undefined) {
          issue(issues, `${path}.${key}`, "is not supported");
          continue;
        }
        validateValue(child, childSchema, `${path}.${key}`, issues);
      }
  }
}

function isNumericMultiple(value: number, multipleOf: number): boolean {
  const valueFraction = decimalFraction(value);
  const multipleFraction = decimalFraction(multipleOf);
  return (
    (valueFraction.numerator * multipleFraction.denominator) %
      (valueFraction.denominator * multipleFraction.numerator) ===
    0n
  );
}

/** Convert the number's canonical JSON-compatible decimal form exactly. */
function decimalFraction(value: number): {
  numerator: bigint;
  denominator: bigint;
} {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(
    value.toString(),
  );
  if (match === null) {
    throw new Error(`Cannot represent finite number ${value} as a decimal`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const fractionDigits = match[3] ?? "";
  const exponent = Number(match[4] ?? "0") - fractionDigits.length;
  const coefficient = sign * BigInt(`${match[2]}${fractionDigits}`);
  return exponent >= 0
    ? { numerator: coefficient * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: coefficient, denominator: 10n ** BigInt(-exponent) };
}

function validateSchemaNode(
  value: unknown,
  root: boolean,
  ancestors: Set<object>,
): value is ExecutorConfigValueSchema {
  if (!isPlainObject(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  const type = value["type"];
  if (
    typeof type !== "string" ||
    !schemaKeysForType(type).hasAll(Object.keys(value))
  ) {
    ancestors.delete(value);
    return false;
  }
  let valid = false;
  if (type === "object") {
    const properties = value["properties"];
    const required = value["required"];
    valid =
      value["additionalProperties"] === false &&
      isPlainObject(properties) &&
      Object.values(properties).every((item) =>
        validateSchemaNode(item, false, ancestors),
      ) &&
      (required === undefined ||
        (Array.isArray(required) &&
          required.every(
            (item) =>
              typeof item === "string" &&
              Object.prototype.hasOwnProperty.call(properties, item),
          ))) &&
      (!root || type === "object");
  } else if (type === "array") {
    valid =
      !root &&
      validateSchemaNode(value["items"], false, ancestors) &&
      optionalNonNegativeInteger(value["minItems"]);
  } else if (type === "string") {
    const pattern = value["pattern"];
    let patternValid = pattern === undefined || typeof pattern === "string";
    if (typeof pattern === "string") {
      try {
        new RegExp(pattern, "u");
      } catch {
        patternValid = false;
      }
    }
    valid =
      !root &&
      optionalNonNegativeInteger(value["minLength"]) &&
      patternValid &&
      (value["enum"] === undefined ||
        (Array.isArray(value["enum"]) &&
          value["enum"].every((item) => typeof item === "string")));
  } else if (type === "number" || type === "integer") {
    valid =
      !root &&
      optionalFiniteNumber(value["minimum"]) &&
      optionalFiniteNumber(value["maximum"]) &&
      optionalPositiveNumber(value["multipleOf"]);
  } else if (type === "boolean") {
    valid = !root;
  }
  if (
    value["description"] !== undefined &&
    typeof value["description"] !== "string"
  ) {
    valid = false;
  }
  ancestors.delete(value);
  return valid;
}

function schemaKeysForType(type: string): {
  hasAll(keys: readonly string[]): boolean;
} {
  const common = ["type", "description"];
  const byType: Readonly<Record<string, readonly string[]>> = {
    string: [...common, "enum", "minLength", "pattern"],
    number: [...common, "minimum", "maximum", "multipleOf"],
    integer: [...common, "minimum", "maximum", "multipleOf"],
    boolean: common,
    array: [...common, "items", "minItems"],
    object: [...common, "properties", "required", "additionalProperties"],
  };
  const allowed = byType[type];
  return {
    hasAll: (keys) =>
      allowed !== undefined && keys.every((key) => allowed.includes(key)),
  };
}

function optionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function optionalPositiveNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value > 0)
  );
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function issue(
  issues: ExecutorConfigValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
