---
name: momentum
description: Operate Momentum, the local-first durable repo-work runtime. Use when asked to preview, start, approve, monitor, watch, inspect, recover, or summarize Momentum workflow runs through the public Momentum CLI, workflow definitions, JSON envelopes, gates, evidence, logs, and recovery commands.
---

# Momentum

Operate Momentum through public CLI contracts. Momentum is a local-first durable
runtime, not an agent: workflow definitions become runs, runs advance through
steps, steps dispatch attempts, attempts accumulate rounds, and durable evidence
outlives process state.

## Load References

- Read `references/cli-discovery.md` before running any Momentum command.
- Read `references/workflow-runs.md` before previewing, starting, approving,
  watching, or supervising workflow runs.
- Read `references/gates-recovery.md` before resolving approvals, operator
  decisions, manual recovery, or failed steps.
- Read `references/evidence-logs.md` before summarizing outcomes or inspecting
  what happened.

## Operating Loop

1. Resolve the Momentum CLI with `scripts/resolve-momentum-cli.mjs`.
2. Prefer read-only JSON surfaces first: `doctor --json`, workflow preview,
   status, handoff, monitor, events, and logs.
3. Treat JSON envelopes, durable events, evidence, and artifact pointers as
   authoritative. Do not scrape terminal prose or process scrollback.
4. Mutate only through explicit public commands: start, approve, decide,
   clear-recovery, update-step, worker, daemon, or intent apply.
5. For side-effecting steps, verify the step's preflight / apply / reconcile
   evidence before reporting success.
6. Report the next operator action as the CLI envelope states it; do not invent
   hidden fallback routes.

## Safety Rules

- Use `--data-dir` when the user supplies one; otherwise let Momentum resolve
  `MOMENTUM_HOME` or `~/.momentum`.
- Use `workflow run preview-coding` for read-only coding workflow plans and
  `workflow run start-coding` only when the user wants the built-in coding
  workflow run materialized.
- Use `workflow run start` for generic workflow definitions. The built-in
  `coding-workflow` definition remains the recipe source of truth.
- Do not encode private deployment vocabulary, local host paths, delivery-layer
  behavior, tracker assumptions, validation-pipeline assumptions, or
  agent-specific product identity into generic Momentum operations.
- When a command refuses, preserve the refusal code and recommended action.
