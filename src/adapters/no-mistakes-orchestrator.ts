/**
 * no-mistakes executor mirror — polling orchestrator (M10-07, NGX-351).
 *
 * `no-mistakes-executor.ts` owns the *pure* half of the mirror: the
 * {@link NoMistakesExternalState} snapshot shape, the daemon classification
 * ({@link decideNoMistakesMirror} / {@link decideNoMistakesUnreadable}), the
 * decision -> round-patch projection ({@link noMistakesRoundUpdate}), and the
 * durable invocation / round-start / finding / decision projections.
 * `no-mistakes-mechanism.ts` owns the IO seam that turns the untrusted external
 * state store into a typed snapshot ({@link NoMistakesExternalStateRead}). This
 * module is the stateful seam that composes both with the *real* M10-03
 * executor-loop persistence layer and round transition graph, exactly the way
 * `single-shot-orchestrator.ts` and `goal-loop-orchestrator.ts` compose their pure
 * projections around a bounded mechanism — but the mirror's "bounded mechanism" is
 * a *read*, and the round is a single long-lived poll loop rather than a one-shot
 * or a bounded round sequence:
 *
 *   read the untrusted external state  (the injected reader; total, never throws)
 *   -> classify it                     (decideNoMistakesMirror / Unreadable)
 *   -> patch the durable round         (continue heartbeat / gate / settle)
 *   -> mirror its findings + decisions (idempotently, append-only)
 *
 * The structural difference from the single-shot / goal-loop drivers is that the
 * mirror does **not** loop internally. No-mistakes owns and runs its own pipeline
 * at its own cadence (ticket "Preserve no-mistakes daemon ownership"; "No rewrite
 * of no-mistakes"), so Momentum never busy-loops on external state: a daemon
 * scheduler *ticks* {@link runNoMistakesMirrorRound} once per poll against the same
 * long-lived round, which lives in `mirroring_external_state` between ticks. Each
 * tick reconciles the durable round with the latest external evidence:
 *
 *   - `continue` is a legal same-state `mirroring_external_state` heartbeat that
 *     keeps the round live for the next tick (no `finished_at`).
 *   - a gate moves it to a durable, non-terminal `waiting_operator` Momentum never
 *     auto-resolves; a later tick can resume it back to `mirroring_external_state`.
 *   - a settle moves it straight to its terminal (`succeeded` directly from the
 *     mirror phase — no intervening capture, unlike the result-bearing families —
 *     or `failed` / `blocked` / `manual_recovery_required`).
 *
 * {@link runNoMistakesMirrorStep} is the entrypoint a daemon / scheduler calls with
 * a `StepRun` identity to *start* a mirror: it materializes the durable invocation
 * and the single round-start row, then runs the first poll and settles the
 * invocation into that poll's decision. Subsequent polls are
 * {@link runNoMistakesMirrorRound} on the existing round; both the invocation and
 * the round can stay non-terminal (`running` / `mirroring_external_state` /
 * `waiting_operator`) across many ticks.
 *
 * The defining discipline is the ticket's "Treat external no-mistakes state as
 * evidence to classify, not blindly trusted authority": the injected reader is
 * total (a missing / unreadable / malformed store returns an `error`, never a
 * throw) and a reader failure routes through {@link decideNoMistakesUnreadable} to
 * the same `manual_recovery_required` settle as a semantically broken snapshot, so
 * a broken external store pauses the workflow for an operator rather than crashing
 * the daemon poll or being trusted.
 */

import type { MomentumDb } from "./db.js";
import {
  ExecutorRoundNotFoundError,
  insertExecutorCheckpoint,
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorInvocation,
  insertExecutorRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  loadExecutorInvocation,
  loadExecutorRound,
  updateExecutorInvocationState,
  updateExecutorRound,
  type ExecutorRoundUpdate
} from "../core/executors/loop/persist.js";
import {
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  type ExecutorDecisionRecord,
  type ExecutorFindingRecord,
  type ExecutorInvocationRecord,
  type ExecutorRoundRecord
} from "../core/executors/loop/reducer.js";
import {
  decideNoMistakesMirror,
  decideNoMistakesUnreadable,
  isNoMistakesExecutorFamily,
  noMistakesRoundUpdate,
  planNoMistakesInvocation,
  planNoMistakesRoundDecisions,
  planNoMistakesRoundFindings,
  planNoMistakesRoundStart,
  type NoMistakesExternalState,
  type NoMistakesMirrorDecision,
  type NoMistakesRoundRuntimeInputs
} from "./no-mistakes-executor.js";
import type { NoMistakesExternalStateRead } from "../core/executors/no-mistakes/mechanism.js";

class NoMistakesMirrorRoundFamilyError extends Error {
  readonly roundId: string;
  readonly executorFamily: string;

  constructor(roundId: string, executorFamily: string) {
    super(
      `No-mistakes mirror cannot poll non-no-mistakes round ${roundId} with family ${executorFamily}`
    );
    this.name = "NoMistakesMirrorRoundFamilyError";
    this.roundId = roundId;
    this.executorFamily = executorFamily;
  }
}

class NoMistakesMirrorRoundTerminalError extends Error {
  readonly roundId: string;
  readonly state: string;

  constructor(roundId: string, state: string) {
    super(
      `No-mistakes mirror cannot poll terminal round ${roundId} in state ${state}`
    );
    this.name = "NoMistakesMirrorRoundTerminalError";
    this.roundId = roundId;
    this.state = state;
  }
}

/**
 * The injected reader one mirror poll runs: it sources and parses the untrusted
 * external no-mistakes state into a typed {@link NoMistakesExternalStateRead}
 * (`{ ok: true; value; digest }` or `{ ok: false; error }`). It receives the live
 * round record so the daemon can locate the external store from the round's frozen
 * `artifactRoot` / identity. It must be *total* — encode a missing / unreadable /
 * malformed store as an `error` rather than throwing — mirroring the mechanism's
 * `readNoMistakesExternalState` / `parseNoMistakesExternalState`, which never
 * throw. The real reader plugs in here (bound to the daemon's state path); tests
 * inject a deterministic fake.
 */
export type NoMistakesMirrorReader = (
  round: ExecutorRoundRecord
) => NoMistakesExternalStateRead;

type NoMistakesExternalIdentity = Pick<
  NoMistakesExternalState,
  "externalRunId" | "branch" | "headSha"
>;

export type NoMistakesExpectedExternalIdentity = NoMistakesExternalIdentity;

const EXTERNAL_STATE_MIRRORED_STAGE = "external_state_mirrored";
const EXPECTED_EXTERNAL_IDENTITY_STAGE = "expected_external_identity";

function externalIdentity(
  state: NoMistakesExternalState
): NoMistakesExternalIdentity {
  return {
    externalRunId: state.externalRunId,
    branch: state.branch,
    headSha: state.headSha
  };
}

function externalIdentityFromCheckpointDetail(
  detail: string | null
): NoMistakesExternalIdentity | null {
  if (detail === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("externalRunId" in parsed) ||
    !("branch" in parsed) ||
    !("headSha" in parsed)
  ) {
    return null;
  }
  const identity = parsed as Record<string, unknown>;
  if (
    typeof identity.externalRunId !== "string" ||
    typeof identity.branch !== "string" ||
    typeof identity.headSha !== "string"
  ) {
    return null;
  }
  return {
    externalRunId: identity.externalRunId,
    branch: identity.branch,
    headSha: identity.headSha
  };
}

function pinnedExternalIdentity(
  db: MomentumDb,
  roundId: string
): NoMistakesExternalIdentity | null {
  for (const checkpoint of listExecutorCheckpointsForRound(db, roundId)) {
    if (checkpoint.stage !== EXTERNAL_STATE_MIRRORED_STAGE) {
      continue;
    }
    const identity = externalIdentityFromCheckpointDetail(checkpoint.detail);
    if (identity !== null) {
      return identity;
    }
  }
  return null;
}

function durableExpectedExternalIdentity(
  db: MomentumDb,
  roundId: string
): NoMistakesExternalIdentity | null {
  for (const checkpoint of listExecutorCheckpointsForRound(db, roundId)) {
    if (checkpoint.stage !== EXPECTED_EXTERNAL_IDENTITY_STAGE) {
      continue;
    }
    const identity = externalIdentityFromCheckpointDetail(checkpoint.detail);
    if (identity !== null) {
      return identity;
    }
  }
  return null;
}

function externalIdentityAnchor(
  db: MomentumDb,
  roundId: string,
  expected: NoMistakesExpectedExternalIdentity | null
): NoMistakesExternalIdentity | null {
  return (
    pinnedExternalIdentity(db, roundId) ??
    durableExpectedExternalIdentity(db, roundId) ??
    expected
  );
}

function describeExternalIdentityMismatch(
  expected: NoMistakesExternalIdentity,
  state: NoMistakesExternalState
): string | null {
  const actual = externalIdentity(state);
  const changed: string[] = [];
  for (const key of ["externalRunId", "branch", "headSha"] as const) {
    if (actual[key] !== expected[key]) {
      changed.push(`${key} expected ${expected[key]} but got ${actual[key]}`);
    }
  }
  return changed.length > 0
    ? `external no-mistakes identity changed: ${changed.join(", ")}`
    : null;
}

function externalIdentityMismatchReason(
  db: MomentumDb,
  roundId: string,
  state: NoMistakesExternalState,
  expected: NoMistakesExpectedExternalIdentity | null
): string | null {
  const anchor = externalIdentityAnchor(db, roundId, expected);
  return anchor === null ? null : describeExternalIdentityMismatch(anchor, state);
}

function noMistakesExternalStateInconsistent(
  reason: string
): NoMistakesMirrorDecision {
  return {
    classification: "manual_recovery_required",
    roundState: "manual_recovery_required",
    invocationState: "manual_recovery_required",
    humanGate: "manual_recovery_required",
    recoveryCode: "external_state_inconsistent",
    reason
  };
}

function insertNewFindings(
  db: MomentumDb,
  roundId: string,
  projected: readonly ExecutorFindingRecord[],
  now: number
): void {
  const existing = listExecutorFindingsForRound(db, roundId);
  const existingIds = new Set(existing.map((finding) => finding.findingId));
  const reservedIds = new Set([
    ...existingIds,
    ...projected.map((finding) => finding.findingId)
  ]);
  for (const finding of projected) {
    const related = existing.filter(
      (candidate) => candidate.externalRef === finding.externalRef
    );
    const latest = related.at(-1);
    if (latest !== undefined && sameFindingEvidence(latest, finding)) {
      continue;
    }
    const findingId =
      latest === undefined && !existingIds.has(finding.findingId)
        ? finding.findingId
        : nextEvidenceId(finding.findingId, reservedIds);
    insertExecutorFinding(db, { ...finding, findingId }, { now });
    existing.push({ ...finding, findingId });
    existingIds.add(findingId);
    reservedIds.add(findingId);
  }
}

function insertNewDecisions(
  db: MomentumDb,
  roundId: string,
  projected: readonly ExecutorDecisionRecord[],
  now: number
): void {
  const existing = listExecutorDecisionsForRound(db, roundId);
  const existingIds = new Set(existing.map((decision) => decision.decisionId));
  const reservedIds = new Set([
    ...existingIds,
    ...projected.map((decision) => decision.decisionId)
  ]);
  for (const decision of projected) {
    const related = existing.filter(
      (candidate) => sameDecisionEvidenceStream(candidate, decision)
    );
    const latest = related.at(-1);
    if (latest !== undefined && sameDecisionEvidence(latest, decision)) {
      continue;
    }
    const decisionId =
      latest === undefined && !existingIds.has(decision.decisionId)
        ? decision.decisionId
        : nextEvidenceId(decision.decisionId, reservedIds);
    insertExecutorDecision(db, { ...decision, decisionId }, { now });
    existing.push({ ...decision, decisionId });
    existingIds.add(decisionId);
    reservedIds.add(decisionId);
  }
}

function nextEvidenceId(baseId: string, existingIds: Set<string>): string {
  for (let version = 2; ; version += 1) {
    const candidate = `${baseId}-snapshot-${version}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
}

function decisionEvidenceBaseId(decisionId: string): string {
  return decisionId.replace(/-snapshot-\d+$/, "");
}

function sameDecisionEvidenceStream(
  left: ExecutorDecisionRecord,
  right: ExecutorDecisionRecord
): boolean {
  if (right.externalRef !== undefined && right.externalRef !== null) {
    return (
      left.externalRef === right.externalRef ||
      (left.externalRef === undefined &&
        decisionEvidenceBaseId(left.decisionId) === right.decisionId) ||
      (left.externalRef === null &&
        decisionEvidenceBaseId(left.decisionId) === right.decisionId)
    );
  }
  return decisionEvidenceBaseId(left.decisionId) === right.decisionId;
}

function decisionEvidenceStreamKey(decision: ExecutorDecisionRecord): string {
  return decision.externalRef ?? decisionEvidenceBaseId(decision.decisionId);
}

function sameFindingEvidence(
  left: ExecutorFindingRecord,
  right: ExecutorFindingRecord
): boolean {
  return (
    left.severity === right.severity &&
    left.title === right.title &&
    left.detail === right.detail &&
    left.selected === right.selected &&
    left.externalRef === right.externalRef
  );
}

function sameDecisionEvidence(
  left: ExecutorDecisionRecord,
  right: ExecutorDecisionRecord
): boolean {
  return (
    left.summary === right.summary &&
    stringArraysEqual(left.allowedActions, right.allowedActions) &&
    left.recommendedAction === right.recommendedAction &&
    left.chosenAction === right.chosenAction &&
    left.resolution === right.resolution
  );
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function insertExternalStateCheckpoint(
  db: MomentumDb,
  roundId: string,
  state: NoMistakesExternalState,
  now: number
): void {
  const sequence = listExecutorCheckpointsForRound(db, roundId).length;
  insertExecutorCheckpoint(
    db,
    {
      checkpointId: `${roundId}-external-state-${sequence}`,
      roundId,
      sequence,
      stage: EXTERNAL_STATE_MIRRORED_STAGE,
      detail: JSON.stringify({
        externalRunId: state.externalRunId,
        branch: state.branch,
        headSha: state.headSha,
        activeStep: state.activeStep,
        stepStatus: state.stepStatus,
        prUrl: state.prUrl,
        ciState: state.ciState
      })
    },
    { now }
  );
}

function insertExpectedExternalIdentityCheckpoint(
  db: MomentumDb,
  roundId: string,
  identity: NoMistakesExpectedExternalIdentity,
  now: number
): void {
  const sequence = listExecutorCheckpointsForRound(db, roundId).length;
  insertExecutorCheckpoint(
    db,
    {
      checkpointId: `${roundId}-expected-external-identity`,
      roundId,
      sequence,
      stage: EXPECTED_EXTERNAL_IDENTITY_STAGE,
      detail: JSON.stringify(identity)
    },
    { now }
  );
}

function noMistakesPollRoundUpdate(
  decision: NoMistakesMirrorDecision,
  stateRead: NoMistakesExternalStateRead,
  polledAt: number
): ExecutorRoundUpdate {
  const finishedAt = isTerminalExecutorRoundState(decision.roundState)
    ? polledAt
    : null;
  const baseUpdate = noMistakesRoundUpdate(decision);
  return stateRead.ok
    ? { ...baseUpdate, inputDigest: stateRead.digest, heartbeatAt: polledAt, finishedAt }
    : { ...baseUpdate, heartbeatAt: polledAt, finishedAt };
}

function updateInvocationForDecision(
  db: MomentumDb,
  invocationId: string,
  decision: NoMistakesMirrorDecision,
  polledAt: number
): void {
  updateExecutorInvocationState(db, invocationId, decision.invocationState, {
    heartbeatAt: polledAt,
    finishedAt: isTerminalExecutorInvocationState(decision.invocationState)
      ? polledAt
      : null,
    now: polledAt
  });
}

function resumeWaitingInvocationBeforeSuccess(
  db: MomentumDb,
  invocationId: string,
  polledAt: number
): void {
  const invocation = loadExecutorInvocation(db, invocationId);
  if (invocation?.state !== "waiting_operator") {
    return;
  }
  updateExecutorInvocationState(db, invocationId, "running", {
    heartbeatAt: polledAt,
    finishedAt: null,
    now: polledAt
  });
}

function isResolvedDecisionRecord(
  decision: Pick<ExecutorDecisionRecord, "resolution">
): boolean {
  return (
    typeof decision.resolution === "string" &&
    decision.resolution.trim().length > 0
  );
}

function unresolvedPriorDecisionCount(
  db: MomentumDb,
  roundId: string,
  state: NoMistakesExternalState
): number {
  const currentlyResolved = new Set(
    planNoMistakesRoundDecisions({ roundId, decisions: state.decisions })
      .filter(isResolvedDecisionRecord)
      .flatMap((decision) => [
        decisionEvidenceStreamKey(decision),
        decisionEvidenceBaseId(decision.decisionId)
      ])
  );
  const latest = new Map<string, ExecutorDecisionRecord>();
  for (const decision of listExecutorDecisionsForRound(db, roundId)) {
    latest.set(decisionEvidenceStreamKey(decision), decision);
  }
  return [...latest.entries()].filter(
    ([baseId, decision]) =>
      !isResolvedDecisionRecord(decision) &&
      !currentlyResolved.has(baseId) &&
      !currentlyResolved.has(decisionEvidenceBaseId(decision.decisionId))
  ).length;
}

function hasPinnedOrExpectedExternalIdentity(
  db: MomentumDb,
  roundId: string,
  expectedExternalIdentity: NoMistakesExpectedExternalIdentity | null
): boolean {
  return externalIdentityAnchor(db, roundId, expectedExternalIdentity) !== null;
}

function withSavepoint<T>(
  db: MomentumDb,
  name: string,
  fn: () => T
): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    } finally {
      try {
        db.exec(`RELEASE SAVEPOINT ${name}`);
      } catch {
      }
    }
    throw error;
  }
}

function reconcileNoMistakesTerminalDecision(
  db: MomentumDb,
  roundId: string,
  stateRead: NoMistakesExternalStateRead,
  decision: NoMistakesMirrorDecision,
  expectedExternalIdentity: NoMistakesExpectedExternalIdentity | null
): NoMistakesMirrorDecision {
  if (!stateRead.ok) {
    return decision;
  }
  if (
    isTerminalExecutorRoundState(decision.roundState) &&
    decision.recoveryCode !== "external_state_unreadable" &&
    !hasPinnedOrExpectedExternalIdentity(db, roundId, expectedExternalIdentity)
  ) {
    return noMistakesExternalStateInconsistent(
      `external no-mistakes run reached terminal ${stateRead.value.stepStatus} before external identity was pinned`
    );
  }
  if (decision.classification !== "complete") {
    return decision;
  }
  const unresolvedCount = unresolvedPriorDecisionCount(
    db,
    roundId,
    stateRead.value
  );
  if (unresolvedCount === 0) {
    return decision;
  }
  return noMistakesExternalStateInconsistent(
    `external no-mistakes run claims completed but ${unresolvedCount} previously mirrored decision(s) are unresolved`
  );
}

export type RunNoMistakesMirrorRoundInput = {
  db: MomentumDb;
  /** The id of the durable, already-started mirror round to poll. */
  roundId: string;
  /** The bounded reader that sources + parses the untrusted external state. */
  read: NoMistakesMirrorReader;
  /** Optional caller-known identity used to corroborate the first readable poll. */
  expectedExternalIdentity?: NoMistakesExpectedExternalIdentity;
  /** Daemon clock stamped as this poll's `heartbeat_at` and terminal `finished_at`. */
  polledAt: number;
};

/**
 * The durable result of one mirror poll: the patched round record, the daemon's
 * decision for this poll, and the round's full durable findings / decisions after
 * the poll (the append-only union across every poll so far).
 */
export type RunNoMistakesMirrorRoundResult = {
  round: ExecutorRoundRecord;
  decision: NoMistakesMirrorDecision;
  /** The round's durable findings after this poll, in surfaced order. */
  findings: ExecutorFindingRecord[];
  /** The round's durable decisions after this poll, in surfaced order. */
  decisions: ExecutorDecisionRecord[];
};

/**
 * Drive one poll of the single long-lived mirror round. See the module doc for the
 * ordered contract: read the untrusted external state, classify it, patch the
 * durable round (a `continue` same-state heartbeat / a `waiting_operator` gate / a
 * terminal settle), and idempotently mirror its findings + decisions.
 *
 * The read is total: a reader failure (missing / unreadable / malformed store)
 * routes through {@link decideNoMistakesUnreadable} to the same
 * `manual_recovery_required` settle as a semantically broken snapshot, never
 * crashing the poll. A successful read additionally re-fingerprints the round's
 * `inputDigest` with the exact external bytes it mirrored this poll, so the durable
 * round reflects the evidence behind its current state (contract "Heartbeat And
 * Reattach"). Findings / decisions are projected only from a readable snapshot — a
 * reader failure invents none and preserves any already mirrored.
 *
 * @throws {ExecutorRoundNotFoundError} if no round has `roundId` — the mirror round
 * must already exist (born at {@link runNoMistakesMirrorStep}); a poll reconciles a
 * started round, it never creates one.
 * @throws {NoMistakesMirrorRoundFamilyError} if `roundId` belongs to a
 * non-no-mistakes executor family.
 * @throws {NoMistakesMirrorRoundTerminalError} if the round is already terminal — a poll
 * must only tick a live (`mirroring_external_state` / `waiting_operator`) round.
 * @throws {ExecutorRoundTransitionError} if persistence rejects the projected
 * round transition.
 */
export function runNoMistakesMirrorRound(
  input: RunNoMistakesMirrorRoundInput
): RunNoMistakesMirrorRoundResult {
  const {
    db,
    roundId,
    read,
    expectedExternalIdentity = null,
    polledAt
  } = input;

  // 1. Load the live round (it must already exist) so the reader can locate the
  //    external store from its frozen artifact root / identity.
  const current = loadExecutorRound(db, roundId);
  if (current === undefined) {
    throw new ExecutorRoundNotFoundError(roundId);
  }
  if (!isNoMistakesExecutorFamily(current.executorFamily)) {
    throw new NoMistakesMirrorRoundFamilyError(roundId, current.executorFamily);
  }
  if (isTerminalExecutorRoundState(current.state)) {
    throw new NoMistakesMirrorRoundTerminalError(roundId, current.state);
  }

  // 2. Read the untrusted external state (total) and classify it. A reader failure
  //    is untrusted evidence too — it settles like a semantically broken snapshot.
  const stateRead = read(current);
  const classified = stateRead.ok
    ? decideNoMistakesMirror(stateRead.value)
    : decideNoMistakesUnreadable(stateRead.error);
  const hasIdentityAnchor = stateRead.ok
    ? hasPinnedOrExpectedExternalIdentity(db, roundId, expectedExternalIdentity)
    : false;
  const identityMismatchReason = stateRead.ok && hasIdentityAnchor
    ? externalIdentityMismatchReason(
        db,
        roundId,
        stateRead.value,
        expectedExternalIdentity
      )
    : null;
  const identityUnpinnedReason =
    stateRead.ok &&
    !hasIdentityAnchor &&
    classified.recoveryCode !== "external_state_unreadable"
      ? "external no-mistakes identity is not pinned"
      : null;
  const identityTrustReason = identityMismatchReason ?? identityUnpinnedReason;
  const identityCorroborated =
    stateRead.ok && hasIdentityAnchor && identityTrustReason === null;
  const identityReconciled =
    identityTrustReason === null ||
    classified.recoveryCode === "external_state_unreadable"
      ? classified
      : noMistakesExternalStateInconsistent(identityTrustReason);
  const decision = reconcileNoMistakesTerminalDecision(
    db,
    roundId,
    stateRead,
    identityReconciled,
    expectedExternalIdentity
  );

  // 3. Patch the durable round, stamping the daemon clock and re-fingerprinting the
  //    round with the exact bytes this poll mirrored (only on a successful read —
  //    a failure has no trustworthy digest, so the frozen one stays in place).
  return withSavepoint(db, "no_mistakes_mirror_poll", () => {
    const roundUpdate = noMistakesPollRoundUpdate(decision, stateRead, polledAt);
    if (decision.invocationState === "succeeded") {
      resumeWaitingInvocationBeforeSuccess(db, current.invocationId, polledAt);
    }
    if (
      current.state === "waiting_operator" &&
      decision.roundState === "succeeded"
    ) {
      updateExecutorRound(
        db,
        roundId,
        {
          ...roundUpdate,
          toState: "mirroring_external_state",
          classification: "continue",
          finishedAt: null
        },
        { now: polledAt }
      );
    }
    const round = updateExecutorRound(db, roundId, roundUpdate, {
      now: polledAt
    });
    updateInvocationForDecision(db, current.invocationId, decision, polledAt);

    // 4. Mirror the snapshot below the round. A reader failure has no snapshot, so
    //    it mirrors nothing and preserves prior evidence.
    if (stateRead.ok && identityCorroborated) {
      insertExternalStateCheckpoint(db, roundId, stateRead.value, polledAt);
      if (decision.recoveryCode !== "external_state_unreadable") {
        insertNewFindings(
          db,
          roundId,
          planNoMistakesRoundFindings({
            roundId,
            findings: stateRead.value.findings,
            selectedFindingIds: stateRead.value.selectedFindingIds
          }),
          polledAt
        );
        insertNewDecisions(
          db,
          roundId,
          planNoMistakesRoundDecisions({
            roundId,
            decisions: stateRead.value.decisions
          }),
          polledAt
        );
      }
    }

    return {
      round,
      decision,
      findings: listExecutorFindingsForRound(db, roundId),
      decisions: listExecutorDecisionsForRound(db, roundId)
    };
  });
}

/**
 * The inputs to {@link runNoMistakesMirrorStep}: the `StepRun` identity
 * (`workflowRunId` / `stepRunId` / `stepKey` / `attempt`), the bounded reader, a
 * per-round runtime-input resolver, and a clock. The adapter mints the invocation
 * / round identities itself, so the caller supplies a `StepRun`, not pre-built
 * executor-loop records. There is no `family` (the mirror serves exactly
 * `no-mistakes`), no selection (no-mistakes owns its own pipeline, so Momentum
 * resolves no agent/model), and no `maxRounds` (the mirror is a single long-lived
 * round, not a bounded sequence).
 */
export type RunNoMistakesMirrorStepInput = {
  db: MomentumDb;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  /** Re-run counter; a fresh attempt mints a fresh invocation, never mutating the prior one. */
  attempt: number;
  /** The bounded reader the first poll runs (the real reader plugs in here). */
  read: NoMistakesMirrorReader;
  /** Caller-known identity used to corroborate the first readable poll. */
  expectedExternalIdentity: NoMistakesExpectedExternalIdentity;
  /** Resolves the round's input digest / artifact root / log paths the daemon provides. */
  resolveRoundInputs: () => NoMistakesRoundRuntimeInputs;
  /** Clock for the invocation + round + poll timestamps; defaults to {@link Date.now}. */
  now?: () => number;
};

/**
 * The durable result of starting a mirror: the settled invocation record and the
 * first poll's outcome. The invocation can be non-terminal (`running` while the
 * external run is still in progress, or a durable `waiting_operator` pause), so a
 * daemon scheduler keeps ticking {@link runNoMistakesMirrorRound} until a poll
 * settles it.
 */
export type RunNoMistakesMirrorStepResult = {
  invocation: ExecutorInvocationRecord;
  round: RunNoMistakesMirrorRoundResult;
};

/**
 * The no-mistakes mirror entrypoint "below `StepRun`" (contract "State Model":
 * `StepRun -> ExecutorInvocation -> ExecutorRound[]`, here exactly one long-lived
 * mirror round). It {@link planNoMistakesInvocation | materializes} the durable
 * `executor_invocations` row with a deterministic, reattachable id, inserts the
 * single {@link planNoMistakesRoundStart | round-start} row (born directly in
 * `mirroring_external_state`, with no agent/model — no-mistakes owns its own
 * pipeline), then runs the first poll through {@link runNoMistakesMirrorRound} and
 * settles the invocation into that poll's decision.
 *
 * The durable invocation + round rows are inserted *before* the first read, so a
 * lost process leaves a durable `running` mirror to reattach to (contract "Round
 * Lifecycle" step 4). Unlike the single-shot driver, the settle is not always
 * terminal: a still-running external run leaves the invocation `running` and a gate
 * leaves it in the durable non-terminal `waiting_operator` (no `finished_at`), for
 * a later {@link runNoMistakesMirrorRound} tick to advance — only a settle stamps
 * `finished_at`.
 *
 * The adapter owns the deterministic id scheme so no caller reinvents it: an
 * invocation reattaches from `(workflowRunId, stepRunId, attempt)` and the round
 * from the invocation id alone (the mirror is always round 0), both recomputable
 * from durable state (contract "Heartbeat And Reattach"). A re-run is a fresh
 * `attempt` minting a fresh invocation, never a mutation of the prior one.
 *
 * @throws {ExecutorInvocationConflictError} if the invocation id already exists
 * (a re-run must use a fresh `attempt`).
 * @throws {ExecutorRoundConflictError} if the round id already exists.
 */
export function runNoMistakesMirrorStep(
  input: RunNoMistakesMirrorStepInput
): RunNoMistakesMirrorStepResult {
  const now = input.now ?? Date.now;
  const { db } = input;

  // 1. Materialize + insert the durable invocation (running) before any read.
  const { invocation, startRecord } = withSavepoint(
    db,
    "no_mistakes_mirror_start",
    () => {
      const invocationStartedAt = now();
      const invocation = planNoMistakesInvocation({
        workflowRunId: input.workflowRunId,
        stepRunId: input.stepRunId,
        stepKey: input.stepKey,
        attempt: input.attempt,
        startedAt: invocationStartedAt
      });
      insertExecutorInvocation(db, invocation, { now: invocationStartedAt });

      // 2. Insert the single mirror round-start row (born in mirroring_external_state),
      //    inheriting the invocation's identity + family and freezing the daemon's
      //    runtime inputs in.
      const roundStartedAt = now();
      const startRecord = planNoMistakesRoundStart({
        invocation,
        runtime: input.resolveRoundInputs(),
        startedAt: roundStartedAt
      });
      insertExecutorRound(db, startRecord, { now: roundStartedAt });
      insertExpectedExternalIdentityCheckpoint(
        db,
        startRecord.roundId,
        input.expectedExternalIdentity,
        roundStartedAt
      );
      return { invocation, startRecord };
    }
  );

  // 3. Run the first poll against the freshly-born round.
  const polledAt = now();
  const roundInput: RunNoMistakesMirrorRoundInput = {
    db,
    roundId: startRecord.roundId,
    read: input.read,
    expectedExternalIdentity: input.expectedExternalIdentity,
    polledAt
  };
  const round = runNoMistakesMirrorRound(roundInput);

  // 4. Settle the invocation into the state the first poll's decision maps to. The
  //    mirror's invocation states are the same as the round's, so a continue keeps
  //    it `running`, a gate pauses it in non-terminal `waiting_operator`, and only a
  //    terminal settle stamps `finished_at`.
  const invocationState = round.decision.invocationState;
  const finalInvocation = updateExecutorInvocationState(
    db,
    invocation.invocationId,
    invocationState,
    {
      heartbeatAt: polledAt,
      finishedAt: isTerminalExecutorInvocationState(invocationState)
        ? polledAt
        : null,
      now: polledAt
    }
  );

  return { invocation: finalInvocation, round };
}
