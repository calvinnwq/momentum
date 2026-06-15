/**
 * Shared timeout / process-kill test fixtures.
 *
 * The heavy integration suites that prove child-process timeout, descendant
 * cleanup, and process-group teardown — `test/live-step-wrapper.test.ts`,
 * `test/single-shot-mechanism.test.ts`, and
 * `test/live-step-orchestrator.test.ts` — repeat a small set of timing
 * primitives around each real process proof. Centralizing them here keeps the
 * per-mechanism assertions in the test files while removing the duplicated,
 * easy-to-mistype scaffolding.
 *
 * `test/foreground-iteration-trusted-shell.test.ts` is the fourth timeout
 * mechanism in the audit, but it is intentionally *not* a consumer: its timeout
 * proof is a plain bounded `sleep` terminated by the runner's own `timeout_sec`,
 * so it shares neither the `waitMs` thread-blocking wait nor the
 * `sigtermImmuneSleep` SIGTERM-trap fragment. Forcing it onto either primitive
 * would change what that proof asserts, so its fixture stays inline.
 *
 * This module has no `*.test.ts` suffix and lives under `test/helpers/`, so
 * neither the fast lane nor the integration lane collects it directly.
 */

/**
 * Synchronously block the calling thread for `ms` milliseconds.
 *
 * Used to let a backgrounded "survivor" descendant reach its marker-writing
 * window — so a test can prove the runtime killed it first — and to pace
 * heartbeat / lease timing probes. `Atomics.wait` on a private, never-notified
 * lock blocks for at least `ms` and works inside both synchronous and async
 * `it` callbacks without yielding the event loop.
 */
export function waitMs(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

/**
 * Shell fragment that installs a no-op SIGTERM trap and then sleeps for
 * `sleepSec` seconds. A mechanism under test must escalate past SIGTERM — to
 * SIGKILL or a process-group kill — to stop it, which is what the timeout
 * proofs assert.
 */
export function sigtermImmuneSleep(sleepSec: number): string {
  return `trap "" TERM; sleep ${sleepSec}`;
}
