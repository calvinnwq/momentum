# Failure and reset semantics (retired goal lane)

> See also: [docs/recovery.md](recovery.md) for stale-lease auto-recovery and manual recovery artifacts; [docs/runners.md](runners.md) for stored runner-profile metadata and failure codes.

This page documents the per-iteration transaction semantics of the retired goal-first execution lane. Nothing executes goal iterations anymore, but stored ledgers, job error rows, events, and recovery artifacts preserve these outcomes and codes as durable compatibility evidence that operators may still need to interpret.

The retired lane treated each iteration as a transaction over the target repo. The pre-iteration HEAD on the Momentum branch was captured as `baseHead` before the runner ran. From there, exactly one of the outcomes in the table below applied.

## Per-iteration outcome matrix

| Outcome | Trigger | Repo effect | Goal state (foreground) | Goal state (queued, via reducer) | JSON error code |
|---|---|---|---|---|---|
| `committed` | Runner success and all verification commands exit 0 | One commit on the Momentum branch with the full staged repo diff | `iteration_complete` (or `completed` if runner sets `goal_complete: true`) | `queued` (continue, next iteration enqueued), `completed` (goal_complete), or `max_iterations_reached` | n/a (`ok: true`) |
| `reset_runner_failure` | Runner reports `success: false`, exits non-zero, times out, cannot spawn, overflows output capture, or writes a missing/invalid result artifact while HEAD remains at `baseHead` | Hard reset to `baseHead`; verification is skipped and a note is written to `verification.log` | `failed` | `failed` (iteration_failed) | `runner_reported_failure`, `command_failed`, `command_timed_out`, `spawn_failed`, `output_overflow`, `result_missing`, `result_invalid`, `runtime_unavailable`, `startup_failed` |
| `reset_verification_failure` | Any verification command exits non-zero | Hard reset to `baseHead` | `failed` | `failed` (iteration_failed) | `verification_failed` |
| `commit_failed` | Verification passed but `git commit` failed | Best-effort hard reset to `baseHead`; if the reset also fails the JSON error code becomes `reset_failed` | `failed` | `failed` (iteration_failed) | `commit_failed` (or `reset_failed`) |
| `reset_failed` | The reset itself failed after a runner or verification failure | Repo may still have uncommitted changes; requires manual inspection | `failed` | `failed` | `reset_failed` |
| `manual_recovery` | Runner advanced HEAD (`runner_changed_head`) or commit/reset saw HEAD no longer at `baseHead` (`head_mismatch`) | Repo is left unchanged so Momentum does not drop non-Momentum commits; both foreground and queued paths write `recovery.md` and set `needs_manual_recovery`; queued workers also keep the repo lock blocking until `recovery clear` | `failed` | `failed` (claims blocked until cleared) | `runner_changed_head`, or `commit_failed` / `reset_failed` with manual-recovery reason `head_mismatch` |

## Early-pipeline error codes

Other early-pipeline errors surface as their own codes and do not produce a commit:

- `invalid_input`
- `missing_repo`
- `unsupported_runner`
- `repo_guard_failed`
- `branch_manager_failed`
- `artifact_write_failed`
- `git_failed`
- `unexpected_error`

## Runner adapter failure preservation

Runner adapter failures preserved their command/runtime/result taxonomy through stored `iteration.code` values, job error rows, and recovery artifacts instead of collapsing into a generic `runner_failed` bucket. The full per-outcome runner codes appear in the table above; the manual-recovery reasons (`runner_changed_head`, `head_mismatch`) are durable and surface in the recovery artifact described in [docs/recovery.md](recovery.md).

## Verification log capture

Verification output was captured to `verification.log` with `[verify]` prefixes. The on-disk buffer is capped so a runaway command could not fill the data directory.
