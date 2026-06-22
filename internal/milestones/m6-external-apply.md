# Milestone 6: Policy-Gated External Apply

**Status:** Complete (NGX-295 through NGX-302).
**Historical/provenance note:** Long-form narrative moved to Obsidian:
`/Workspaces/Momentum/Specs/2026-06-22-momentum-runtime-milestone-provenance.md`.

M6 contract source of truth: `internal/contracts/intent-apply.md` and
`internal/contracts/source-adapters.md`.

## Milestone goal

Land a two-phase Linear external apply path gated by `MOMENTUM.md`
`intent_apply_policy: external_apply_allowed`.

## Shipped issue order

NGX-295, NGX-296, NGX-297, NGX-299, NGX-298, NGX-300, NGX-301, NGX-302.
Ordering invariant: NGX-299 audit surfaces landed before NGX-298 external apply.

## Headline safety invariants

two-phase; audit-before-apply; blocked / non-replay state; per-intent
concurrency guard with `intent_apply_in_progress`; comment-only default;
idempotency marker; single-issue post-apply reconcile; tests must not call
real `api.linear.app`.

## M6 non-goals (explicit)

Inbound webhooks; Dashboard or UI surface; Autonomous external writes;
non-Linear adapters; broader runner/sandbox changes; per-source-item worktrees;
background runner supervision; cooperative cancellation; remote git operations.

## M3 / M4 / M5 contracts preserved through M6

`daemon start`, `daemon stop`, `daemon status`, `recovery clear`,
`RunnerAdapter`, `fake`, `trusted-shell`, `acp`, `MOMENTUM.md`, SourceItem,
source snapshot, reconciliation run, evidence record, and update intent schemas
remain wire-stable.

## Post-M6 deferrals

Inbound webhooks, dashboard/UI, autonomous external writes, non-Linear adapters,
parallel same-repo Goals, strong sandboxing, and remote git operations remain
deferred unless a later milestone explicitly changes them.
