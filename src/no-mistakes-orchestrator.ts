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
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorInvocation,
  insertExecutorRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  loadExecutorRound,
  updateExecutorInvocationState,
  updateExecutorRound,
  type ExecutorRoundUpdate
} from "./executor-loop-persist.js";
import {
  isTerminalExecutorInvocationState,
  isTerminalExecutorRoundState,
  type ExecutorDecisionRecord,
  type ExecutorFindingRecord,
  type ExecutorInvocationRecord,
  type ExecutorRoundRecord
} from "./executor-loop-reducer.js";
import {
  decideNoMistakesMirror,
  decideNoMistakesUnreadable,
  noMistakesRoundUpdate,
  planNoMistakesInvocation,
  planNoMistakesRoundDecisions,
  planNoMistakesRoundFindings,
  planNoMistakesRoundStart,
  type NoMistakesMirrorDecision,
  type NoMistakesRoundRuntimeInputs
} from "./no-mistakes-executor.js";
import type { NoMistakesExternalStateRead } from "./no-mistakes-mechanism.js";

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

/**
 * Append the findings/decisions a poll surfaced below the round *idempotently*: the
 * evidence tables are append-only (a duplicate id throws), and the mirror is a
 * long-lived round that re-derives the same deterministic finding/decision ids on
 * every poll, so only ids not already durable are inserted. A later poll's
 * newly-surfaced findings are appended; previously-surfaced ones are left intact
 * (their first-seen `selected` flag / resolution stands — the append-only table
 * records evidence as it first appeared).
 */
function insertNewFindings(
  db: MomentumDb,
  roundId: string,
  projected: readonly ExecutorFindingRecord[],
  now: number
): void {
  const existing = new Set(
    listExecutorFindingsForRound(db, roundId).map((f) => f.findingId)
  );
  for (const finding of projected) {
    if (!existing.has(finding.findingId)) {
      insertExecutorFinding(db, finding, { now });
    }
  }
}

function insertNewDecisions(
  db: MomentumDb,
  roundId: string,
  projected: readonly ExecutorDecisionRecord[],
  now: number
): void {
  const existing = new Set(
    listExecutorDecisionsForRound(db, roundId).map((d) => d.decisionId)
  );
  for (const decision of projected) {
    if (!existing.has(decision.decisionId)) {
      insertExecutorDecision(db, decision, { now });
    }
  }
}

export type RunNoMistakesMirrorRoundInput = {
  db: MomentumDb;
  /** The id of the durable, already-started mirror round to poll. */
  roundId: string;
  /** The bounded reader that sources + parses the untrusted external state. */
  read: NoMistakesMirrorReader;
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
 * @throws {ExecutorRoundTransitionError} if the round is already terminal — a poll
 * must only tick a live (`mirroring_external_state` / `waiting_operator`) round.
 */
export function runNoMistakesMirrorRound(
  input: RunNoMistakesMirrorRoundInput
): RunNoMistakesMirrorRoundResult {
  const { db, roundId, read, polledAt } = input;

  // 1. Load the live round (it must already exist) so the reader can locate the
  //    external store from its frozen artifact root / identity.
  const current = loadExecutorRound(db, roundId);
  if (current === undefined) {
    throw new ExecutorRoundNotFoundError(roundId);
  }

  // 2. Read the untrusted external state (total) and classify it. A reader failure
  //    is untrusted evidence too — it settles like a semantically broken snapshot.
  const stateRead = read(current);
  const decision = stateRead.ok
    ? decideNoMistakesMirror(stateRead.value)
    : decideNoMistakesUnreadable(stateRead.error);

  // 3. Patch the durable round, stamping the daemon clock and re-fingerprinting the
  //    round with the exact bytes this poll mirrored (only on a successful read —
  //    a failure has no trustworthy digest, so the frozen one stays in place).
  const finishedAt = isTerminalExecutorRoundState(decision.roundState)
    ? polledAt
    : null;
  const baseUpdate = noMistakesRoundUpdate(decision);
  const roundUpdate: ExecutorRoundUpdate = stateRead.ok
    ? { ...baseUpdate, inputDigest: stateRead.digest, heartbeatAt: polledAt, finishedAt }
    : { ...baseUpdate, heartbeatAt: polledAt, finishedAt };
  const round = updateExecutorRound(db, roundId, roundUpdate, { now: polledAt });

  // 4. Mirror the snapshot's findings + decisions below the round, idempotently
  //    (the round is long-lived and re-derives the same ids each poll). A reader
  //    failure has no snapshot, so it mirrors nothing and preserves prior evidence.
  if (stateRead.ok) {
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

  return {
    round,
    decision,
    findings: listExecutorFindingsForRound(db, roundId),
    decisions: listExecutorDecisionsForRound(db, roundId)
  };
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

  // 3. Run the first poll against the freshly-born round.
  const polledAt = now();
  const round = runNoMistakesMirrorRound({
    db,
    roundId: startRecord.roundId,
    read: input.read,
    polledAt
  });

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
