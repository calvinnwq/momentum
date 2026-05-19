# End-to-end Walkthrough

This page documents the disposable end-to-end run that exercises Momentum's queued default path, the M3 managed daemon drain alternative, and the Milestone 1 foreground debug path. It composes the M2 queue / worker, the M3 daemon / recovery, and the iteration → verification → commit / reset transaction into a single repeatable smoke that can be run from any clone of this repo.

See also:

- [Roadmap and milestone status](roadmap.md) — current milestone and per-milestone docs.
- [Recovery surfaces (NGX-276, NGX-277)](recovery.md) — stale-lease auto-recovery and manual recovery artifacts that this walkthrough's daemon path exercises.
- [Runner profiles and repo policy](runners.md) — runner family detail referenced by the `runner: fake` example below.

## Queued default path

Drive a fresh disposable run from anywhere in this repo. The default path is **queued**: `goal start` enqueues a `goal_iteration` job, and `worker run` drains the queue one iteration at a time.

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

cat > "$DATA/goal.md" <<'EOF'
---
title: Smoke Goal
repo: REPO_PLACEHOLDER
runner: fake
verification:
  - "true"
---

End-to-end smoke goal.
EOF
sed -i.bak "s|REPO_PLACEHOLDER|$REPO|" "$DATA/goal.md" && rm "$DATA/goal.md.bak"

# 1. Enqueue the first iteration (queued default path).
node dist/index.js goal start "$DATA/goal.md" --data-dir "$DATA" --json
GOAL_ID=$(ls "$DATA/goals" | head -n 1)

# 2. Drain one queued goal_iteration job.
node dist/index.js worker run --data-dir "$DATA" --json

# 3. Inspect queued lifecycle through status / logs / handoff.
node dist/index.js status "$GOAL_ID" --data-dir "$DATA" --json
node dist/index.js logs "$GOAL_ID" --data-dir "$DATA" --json
node dist/index.js handoff "$GOAL_ID" --data-dir "$DATA" --json
```

Replacing the `verification: ["true"]` line with `verification: ["false"]` exercises the failure-reset path: the queued `goal_iteration` job fails, the worktree is reset to its pre-iteration HEAD, `verification.log` records the failed command, and `status --json` exposes `latestJob.errorPath` plus the `artifacts` block for inspection.

## Managed daemon drain (M3 alternative)

`worker run` is the single-shot consumer (step 2 above): one invocation drains one claimed job. The M3 managed loop on `daemon start` is the bounded continuous-draining equivalent — composes `runWorkerOnce` in-process, runs the NGX-276 startup-recovery pre-pass, and exits cleanly when a bound, `daemon stop`, `daemon stop --now`, or terminal daemon-run state is observed:

```bash
# Drain queued goal_iteration jobs until idle (alternative to repeated `worker run`).
node dist/index.js daemon start --data-dir "$DATA" --max-idle-cycles 2 --poll-interval-ms 0 --json
node dist/index.js daemon status --data-dir "$DATA" --json
```

Pick `worker run` when you want a one-shot iteration claim with no orchestrator-run record; pick `daemon start --max-*` when you want to drain multiple chained iterations under a single `daemon_runs` row that `daemon status`, `status --json`, and `handoff` can surface. Both paths share the same queue and produce the same artifacts.

## Foreground debug path

`--foreground` is retained as a Milestone 1 inline debugging path. It bypasses the queue and runs one iteration synchronously, useful when iterating on runner profiles or reproducing a single iteration locally without the worker:

```bash
node dist/index.js goal start "$DATA/goal.md" \
  --foreground --repo "$REPO" --data-dir "$DATA" --runner fake --json
```

Day-to-day execution should use the default queued path so the reducer can chain iterations and the queue can be inspected with `status` / `logs` / `handoff`.
