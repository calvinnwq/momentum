# End-to-end Walkthrough

This page documents a disposable end-to-end run that exercises Momentum's workflow-first path: start a durable workflow run, let a bounded daemon cycle run the workflow scheduler lane, and inspect the run through the read-only workflow surfaces.
It can be run from any clone of this repo with a scratch repository and a scratch `--data-dir`, and it writes nothing outside those scratch directories.
Run process-backed portions of the walkthrough on Linux or macOS.
Native Windows is not a supported or CI-proven host; executable workflow steps
refuse with `unsupported_platform` before a supervised command is spawned.

See also:

- [Workflow commands](workflow-commands.md) — the full `workflow run start`, approval, monitor, watch, events, and logs envelopes this walkthrough composes.
- [Daemon commands](daemon.md) — the managed daemon loop and its workflow scheduler lane.
- [Recovery surfaces](recovery.md) — stale-lease auto-recovery, run-scoped workflow recovery, and the stored-goal `recovery clear` surface.

## Start a durable workflow run

Drive a fresh disposable run from anywhere in this repo:

```bash
pnpm build
REPO=$(mktemp -d)
DATA=$(mktemp -d)
git -C "$REPO" init --initial-branch=main --quiet
git -C "$REPO" config user.email you@example.com
git -C "$REPO" config user.name "You"
printf "smoke\n" > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -m init --quiet

# 1. Check local runtime readiness.
node dist/index.js doctor --data-dir "$DATA" --json

# 2. Start a durable workflow run from the built-in coding-workflow definition.
node dist/index.js workflow run start \
  --run-id demo-1 \
  --repo "$REPO" \
  --objective "Make the requested change" \
  --data-dir "$DATA" --json
```

`workflow run start` resolves the built-in `coding-workflow` definition, loads repo policy, and durably persists one `workflow_runs` row plus six ordered `workflow_steps` rows (`preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`).
The success envelope reports `"state": "pending"`, `"definitionKey": "coding-workflow"`, and `"counts": {"steps": 6}`.

## Run one bounded daemon cycle

The managed daemon loop is the scheduler for approved workflow steps.
It runs a startup-recovery pre-pass before cycling, then each cycle runs one workflow scheduler tick that recovers stale workflow leases and claims one runnable approved step:

```bash
# 3. Run the workflow scheduler lane for one bounded idle cycle.
node dist/index.js daemon start --data-dir "$DATA" --max-idle-cycles 1 --poll-interval-ms 0 --json
node dist/index.js daemon status --data-dir "$DATA" --json
```

With no approved steps yet, the bounded loop exits cleanly with `loop.exitReason: "max_idle_cycles"`, `loop.lastWorkflowCode: "idle"`, and `loop.workflowStepsDispatched: 0`, and `daemon status` then reports the terminal `stopped` daemon run.
Dispatching real work additionally requires an approval (below) and, for profile-backed step kinds including native `goal-loop`, `one-shot`, and `script`, a configured `MOMENTUM_LIVE_WRAPPER_PROFILE`; see [Daemon commands](daemon.md).

## Inspect the run

```bash
# 4. Inspect durable run state, logs/evidence, and the next-action packet.
node dist/index.js workflow status demo-1 --data-dir "$DATA" --json
node dist/index.js workflow run logs demo-1 --data-dir "$DATA" --json
node dist/index.js workflow handoff demo-1 --data-dir "$DATA" --json
```

All three surfaces are read-only:

- `workflow status demo-1` returns the run row plus every step with its `kind`, `state`, and ordering.
- `workflow run logs demo-1` returns the same detail shape plus `invocations` and `rounds` evidence arrays (both empty until an executor has run).
- `workflow handoff demo-1` lifts `nextAction` to the top level; on a fresh run it reports `code: "await_approval"` with `actionClass: "approve_next_gate"` for the `preflight` step.

## Approve and continue

Recording a durable approval is what makes steps runnable for the scheduler lane:

```bash
# 5. Record an explicit approval boundary for the run.
node dist/index.js workflow run approve demo-1 \
  --approval-boundary through-implementation \
  --phrase "approve demo-1 through implementation" \
  --actor operator \
  --data-dir "$DATA" --json
node dist/index.js workflow handoff demo-1 --data-dir "$DATA" --json
```

After the approval, the run state is `approved`, the steps inside the boundary are `approved`, and `workflow handoff` reports `code: "advance_to_step"` with `actionClass: "continue_polling"` for `preflight`.
From here, the next bounded `daemon start --max-idle-cycles ...` cycle can claim and dispatch the approved step when a live-wrapper profile is configured.

For ongoing supervision — `workflow run monitor`, `workflow run watch --once`, `workflow run watch --stream --jsonl`, and `workflow run events` — see [Workflow commands](workflow-commands.md).
For manual-recovery flags, `workflow run clear-recovery`, and the stored-goal `recovery clear <goal-id>` surface, see [Recovery surfaces](recovery.md).
