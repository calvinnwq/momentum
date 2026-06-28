import type { MomentumDb } from "../../adapters/db.js";
import { loadWorkflowRunEvents } from "./events.js";
import { WORKFLOW_RUN_TERMINAL_STATES } from "./run-reducer.js";
import type { WorkflowWatchStreamPollResult } from "./watch-stream.js";

/**
 * Raised when the durable poll source cannot find the workflow run it streams.
 *
 * The driver surfaces this verbatim so the CLI layer can map a missing run to a
 * `run_not_found` refusal instead of streaming an empty heartbeat forever.
 */
export class WorkflowWatchStreamRunNotFoundError extends Error {
  readonly code = "run_not_found";

  constructor(readonly runId: string) {
    super(`Workflow run not found: ${runId}`);
    this.name = "WorkflowWatchStreamRunNotFoundError";
  }
}

/**
 * A synchronous durable poll source. The underlying SQLite reads are
 * synchronous, so the source returns a {@link WorkflowWatchStreamPollResult}
 * directly; it stays assignable to the driver's `WorkflowWatchStreamPoll` seam,
 * whose return type widens to a promise.
 */
export type WorkflowWatchStreamDbPoll = (
  since: string | null
) => WorkflowWatchStreamPollResult;

/**
 * Create a durable {@link WorkflowWatchStreamDbPoll} backed by the SUP-04 event
 * cursor API and the run row's terminal state.
 *
 * Each poll performs two durable reads against the same {@link MomentumDb}: the
 * replayable semantic events after the caller's resume cursor
 * ({@link loadWorkflowRunEvents}), and the run row's current state so the driver
 * recognises an already-terminal run even when it reconnects from a cursor at or
 * past the projected `terminal_state` event. That event is filtered out of the
 * envelope once consumed, so the run row is the only terminal signal left to a
 * reconnecting stream; reading it out-of-band per poll is what keeps a resumed
 * stream behaviourally specified. The source retains no event history - it reads,
 * returns, and forgets - so the driver stays memory-bounded for the lifetime of
 * the stream.
 */
export function createWorkflowWatchStreamDbPoll(
  db: MomentumDb,
  runId: string
): WorkflowWatchStreamDbPoll {
  return (since): WorkflowWatchStreamPollResult => {
    const events = loadWorkflowRunEvents(db, runId, { since });
    if (events === null) {
      throw new WorkflowWatchStreamRunNotFoundError(runId);
    }
    return { events, runTerminal: isWorkflowRunRowTerminal(db, runId) };
  };
}

function isWorkflowRunRowTerminal(db: MomentumDb, runId: string): boolean {
  const row = db
    .prepare("SELECT state FROM workflow_runs WHERE id = ?")
    .get(runId) as { state: string } | undefined;
  if (row === undefined) return false;
  return (WORKFLOW_RUN_TERMINAL_STATES as readonly string[]).includes(row.state);
}
