/**
 * no-mistakes executor mirror — external-state reader (M10-07, NGX-351).
 *
 * `no-mistakes-executor.ts` owns the *pure* half of the mirror: the
 * {@link NoMistakesExternalState} snapshot shape, the daemon classification
 * (`decideNoMistakesMirror`), and the durable finding / decision projections. It
 * is a pure function of an *already-typed* snapshot. This module is the IO seam
 * that produces that snapshot: it reads the untrusted external no-mistakes state
 * store and turns its raw bytes into a typed {@link NoMistakesExternalState} the
 * brain can classify — exactly the way `goal-loop-mechanism.ts` is the seam
 * between "the round's agent wrote a result document" and "the daemon classifies
 * and persists", and `single-shot-mechanism.ts` is the seam that runs the bounded
 * command. Here the bounded work is a *read*: no-mistakes owns and runs its own
 * pipeline (ticket "No rewrite of no-mistakes"; contract "Replacement of GNHF or
 * no-mistakes internals" is a non-goal), so Momentum only mirrors enough state to
 * decide workflow progress (contract "External Executor Mirroring").
 *
 * The defining discipline is the ticket's "Treat external no-mistakes state as
 * evidence to classify, not blindly trusted authority" and the contract's
 * "External state strings are never enough on their own." That splits cleanly
 * across the two modules:
 *
 *   - This reader owns *structural* (JSON-type) validation: is the store even the
 *     right shape? It rejects a missing / unreadable file, non-JSON bytes, a
 *     non-object root, and any field whose JSON type does not match the snapshot
 *     (a numeric `headSha`, a string `findings`, a finding that is not an object,
 *     a non-string selected id, a decision with non-array `allowedActions`). It
 *     does *not* re-validate the values the brain owns.
 *   - The brain ({@link decideNoMistakesMirror}) owns *semantic* validation: enum
 *     membership (`stepStatus` / `ciState`), the 40-hex `headSha` format, blank
 *     ids, dangling selected findings, duplicate ids, and the cross-field
 *     completion checks. So a well-typed but semantically bad snapshot — an
 *     unknown `stepStatus`, a dangling selected id — parses *here* and is routed
 *     to `manual_recovery_required` *there*. Enum-typed string fields are read as
 *     strings and passed through unchecked for exactly this reason.
 *
 * Both entrypoints return the same {@link NoMistakesExternalStateRead} discriminated
 * union — `{ ok: true; value; digest }` or `{ ok: false; error }` — mirroring
 * `parseRunnerResult`'s convention. The `digest` is a `sha256:` content digest of
 * the raw bytes the snapshot was parsed from (the round-schema `input_digest`
 * reattach fingerprint), so the durable round can fingerprint the exact external
 * evidence it mirrored. The reader is *total*: it never throws on untrusted
 * bytes, returning an `error` reason instead, the same way the brain never throws
 * on an untrusted snapshot.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import type {
  NoMistakesCiState,
  NoMistakesExternalDecision,
  NoMistakesExternalFinding,
  NoMistakesExternalState,
  NoMistakesExternalStepStatus
} from "./no-mistakes-executor.js";

/** A successful read: the typed snapshot plus the raw-bytes content digest. */
export type NoMistakesExternalStateReadSuccess = {
  ok: true;
  value: NoMistakesExternalState;
  /** `sha256:` content digest of the raw bytes the snapshot was parsed from. */
  digest: string;
};

/** A failed read: the raw bytes could not be turned into a typed snapshot. */
export type NoMistakesExternalStateReadError = {
  ok: false;
  /** Why the external state could not be read into a typed snapshot. */
  error: string;
};

/**
 * The result of reading the external no-mistakes state store. Mirrors
 * `parseRunnerResult`'s `{ ok: true; value } | { ok: false; error }` convention,
 * adding the raw-bytes content `digest` on success. Total: never thrown, always
 * one of these two shapes.
 */
export type NoMistakesExternalStateRead =
  | NoMistakesExternalStateReadSuccess
  | NoMistakesExternalStateReadError;

/** The inputs to {@link readNoMistakesExternalState}: the external state file path. */
export type ReadNoMistakesExternalStateInput = {
  /** Path to the external no-mistakes state JSON document the daemon maintains. */
  statePath: string;
};

/**
 * Read the external no-mistakes state file and parse it into a typed snapshot.
 * The IO twin of {@link parseNoMistakesExternalState}: it reads the raw bytes
 * (returning an `error` when the file is missing / unreadable) then delegates to
 * the pure parser, so the `digest` always fingerprints the exact bytes on disk.
 * Total: a missing file or unreadable path becomes an `error`, never a throw.
 */
export function readNoMistakesExternalState(
  input: ReadNoMistakesExternalStateInput
): NoMistakesExternalStateRead {
  let raw: string;
  try {
    raw = fs.readFileSync(input.statePath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `external no-mistakes state file is unreadable: ${detail}`
    };
  }
  return parseNoMistakesExternalState(raw);
}

/**
 * Parse raw external no-mistakes state bytes into a typed {@link NoMistakesExternalState}
 * snapshot. Pure: the same bytes always yield the same result, and *any* input —
 * including malformed JSON or a wrong-typed field — yields a result rather than a
 * throw, because the store is untrusted external evidence.
 *
 * Owns *structural* (JSON-type) validation only; the brain owns the semantics. See
 * the module doc for the boundary. On success the `digest` is the `sha256:`
 * content digest of `raw`.
 */
export function parseNoMistakesExternalState(
  raw: string
): NoMistakesExternalStateRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      error: `external no-mistakes state is not valid JSON: ${detail}`
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "external no-mistakes state must be a JSON object"
    };
  }

  const externalRunId = readString(parsed, "externalRunId");
  if (!externalRunId.ok) return externalRunId;
  const branch = readString(parsed, "branch");
  if (!branch.ok) return branch;
  const headSha = readString(parsed, "headSha");
  if (!headSha.ok) return headSha;
  const activeStep = readNullableString(parsed, "activeStep");
  if (!activeStep.ok) return activeStep;
  const stepStatus = readString(parsed, "stepStatus");
  if (!stepStatus.ok) return stepStatus;
  const ciState = readString(parsed, "ciState");
  if (!ciState.ok) return ciState;
  const prUrl = readNullableString(parsed, "prUrl");
  if (!prUrl.ok) return prUrl;

  const findings = readFindings(parsed);
  if (!findings.ok) return findings;
  const selectedFindingIds = readStringArray(parsed, "selectedFindingIds");
  if (!selectedFindingIds.ok) return selectedFindingIds;
  const decisions = readDecisions(parsed);
  if (!decisions.ok) return decisions;

  const value: NoMistakesExternalState = {
    externalRunId: externalRunId.value,
    branch: branch.value,
    headSha: headSha.value,
    activeStep: activeStep.value,
    // Enum-typed fields are passed through as strings; the brain validates
    // membership and routes an unknown value to manual recovery.
    stepStatus: stepStatus.value as NoMistakesExternalStepStatus,
    findings: findings.value,
    selectedFindingIds: selectedFindingIds.value,
    decisions: decisions.value,
    prUrl: prUrl.value,
    ciState: ciState.value as NoMistakesCiState
  };
  return { ok: true, value, digest: contentDigest(raw) };
}

/** A field-read outcome: the typed value, or the read error to short-circuit on. */
type FieldRead<T> = { ok: true; value: T } | NoMistakesExternalStateReadError;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a required string field, erroring when absent or not a string. */
function readString(
  obj: Record<string, unknown>,
  key: string
): FieldRead<string> {
  const value = obj[key];
  if (typeof value !== "string") {
    return { ok: false, error: `external no-mistakes state ${key} must be a string` };
  }
  return { ok: true, value };
}

/** Read a `string | null` field, erroring when present but neither. Absent -> null. */
function readNullableString(
  obj: Record<string, unknown>,
  key: string
): FieldRead<string | null> {
  const value = obj[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `external no-mistakes state ${key} must be a string or null`
    };
  }
  return { ok: true, value };
}

/** Read an optional descriptive string field (absent / null -> null). */
function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  context: string
): FieldRead<string | null> {
  const value = obj[key];
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: `external no-mistakes state ${context} ${key} must be a string or null`
    };
  }
  return { ok: true, value };
}

/** Read a required array-of-strings field. */
function readStringArray(
  obj: Record<string, unknown>,
  key: string
): FieldRead<string[]> {
  const value = obj[key];
  if (!Array.isArray(value)) {
    return { ok: false, error: `external no-mistakes state ${key} must be an array` };
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `external no-mistakes state ${key} must contain only strings`
      };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

/** Read the `findings` array into typed {@link NoMistakesExternalFinding} rows. */
function readFindings(
  obj: Record<string, unknown>
): FieldRead<NoMistakesExternalFinding[]> {
  const value = obj.findings;
  if (!Array.isArray(value)) {
    return { ok: false, error: "external no-mistakes state findings must be an array" };
  }
  const out: NoMistakesExternalFinding[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return {
        ok: false,
        error: "external no-mistakes state finding must be an object"
      };
    }
    const externalId = readString(entry, "externalId");
    if (!externalId.ok) {
      return { ok: false, error: "external no-mistakes state finding externalId must be a string" };
    }
    const title = readString(entry, "title");
    if (!title.ok) {
      return { ok: false, error: "external no-mistakes state finding title must be a string" };
    }
    const severity = readOptionalString(entry, "severity", "finding");
    if (!severity.ok) return severity;
    const detail = readOptionalString(entry, "detail", "finding");
    if (!detail.ok) return detail;
    out.push({
      externalId: externalId.value,
      title: title.value,
      severity: severity.value,
      detail: detail.value
    });
  }
  return { ok: true, value: out };
}

/** Read the `decisions` array into typed {@link NoMistakesExternalDecision} rows. */
function readDecisions(
  obj: Record<string, unknown>
): FieldRead<NoMistakesExternalDecision[]> {
  const value = obj.decisions;
  if (!Array.isArray(value)) {
    return { ok: false, error: "external no-mistakes state decisions must be an array" };
  }
  const out: NoMistakesExternalDecision[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return {
        ok: false,
        error: "external no-mistakes state decision must be an object"
      };
    }
    const externalId = readString(entry, "externalId");
    if (!externalId.ok) {
      return { ok: false, error: "external no-mistakes state decision externalId must be a string" };
    }
    const summary = readString(entry, "summary");
    if (!summary.ok) {
      return { ok: false, error: "external no-mistakes state decision summary must be a string" };
    }
    const allowedActions = readStringArray(entry, "allowedActions");
    if (!allowedActions.ok) {
      return {
        ok: false,
        error: "external no-mistakes state decision allowedActions must be an array of strings"
      };
    }
    const recommendedAction = readOptionalString(
      entry,
      "recommendedAction",
      "decision"
    );
    if (!recommendedAction.ok) return recommendedAction;
    const chosenAction = readOptionalString(entry, "chosenAction", "decision");
    if (!chosenAction.ok) return chosenAction;
    const resolution = readOptionalString(entry, "resolution", "decision");
    if (!resolution.ok) return resolution;
    out.push({
      externalId: externalId.value,
      summary: summary.value,
      allowedActions: allowedActions.value,
      recommendedAction: recommendedAction.value,
      chosenAction: chosenAction.value,
      resolution: resolution.value
    });
  }
  return { ok: true, value: out };
}

/** The self-describing `sha256:` content digest of an artifact's raw bytes. */
function contentDigest(raw: string): string {
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}
