# Contract: Intent Apply (Two-Phase External Apply)

**Status:** M6 contract. This document captures the safety invariants for the two-phase external apply path that lands in Milestone 6 ([internal/milestones/m6-external-apply.md](../milestones/m6-external-apply.md)). The runtime implementation lands across NGX-296..NGX-302. NGX-295 (M6-00) pins the contract.

In Milestone 5, `intent apply --external-apply` is always refused with `external_apply_unsupported`. Milestone 6 introduces the gated external apply path described below. Every constraint here is a safety invariant — runtime code, tests, and operator surfaces all must respect it.

## Scope

This contract covers `intent apply --external-apply` for the Linear external write adapter introduced in M6 (NGX-297). It does not cover M5's manual-mark `intent apply` (which records the operator decision locally without any external write), `intent skip`, or `intent cancel`. Those remain wire-stable and are not affected by this contract.

## Lifecycle: claim → audit → external write → finalize

`intent apply --external-apply` is **two-phase**, not a single round-trip. The runtime executes a strict four-step lifecycle:

1. **claim** — The runtime performs a compare-and-swap (CAS) on the per-intent apply state. If another apply is already in flight for this intent, the claim fails with the stable `intent_apply_in_progress` result and no other side effect occurs. The successful claim transitions the intent into an in-flight state with a claim id, claim timestamp, and operator reason.
2. **audit** — The runtime captures and persists the **audit-before-write** record: the exact payload that will be sent, the resolved target Linear issue id, the `intent_apply_policy` value, the operator reason, the comment-vs-status decision, and the idempotency marker the runtime intends to write. The audit row must be durable before the external write is attempted. If the audit step fails, the intent is released back to `pending` (claim rolled back) and no external write happens.
3. **external write** — The runtime calls the Linear write client. Comment-only is the default unless target Linear status mutation is explicitly configured for this adapter / intent. The external write carries the idempotency marker pinned in the audit row. If the external write fails before any Linear-side state has changed, the intent is released back to `pending` and the failure is recorded on the audit row.
4. **finalize** — The runtime persists the external write outcome (Linear comment id or status transition id, server timestamp, response payload digest) and transitions the intent to `applied`. The audit row is updated with the finalize timestamp and the external identifier returned by Linear.

This is the safety ordering. **Audit-before-apply** is not a stylistic preference — code paths must persist the audit row before the external write is attempted.

## Blocked / non-replay state on partial failure

If the **external write succeeds** but the **audit-finalize step fails** (database write failure, process crash mid-finalize, etc.), the intent transitions to a `blocked` non-replay state. The semantics are:

- Linear is now mutated; Momentum's local record may not yet reflect that.
- A retry must **not** re-issue the external write. Re-running `intent apply --external-apply` against a `blocked` intent returns a stable error (the intent is `blocked`; operator must use the recovery path).
- The recovery path is operator-driven: the operator inspects Linear (or the audit row + Linear via the post-apply single-issue reconcile of NGX-301), confirms the external state, and explicitly clears `blocked`. Until the operator clears `blocked`, the intent stays non-replayable.
- An intent in `blocked` must remain visible through `intent list`, `intent get`, `status`, `handoff`, `project status`, and `doctor` so it is impossible to forget.

The contract is: external writes are not auto-replayed under any circumstance, because the post-write window is the only window where Momentum cannot tell from local state alone whether Linear is already mutated.

## Per-intent concurrency guard: CAS and `intent_apply_in_progress`

Concurrency control is per-intent. Two `intent apply --external-apply` invocations against the same intent id must not both reach the external write step.

- The runtime uses a compare-and-swap (CAS) on the per-intent apply state to enforce single-claim semantics. The CAS column / claim id / claim timestamp shape lands in NGX-296.
- A failed claim returns a **stable `intent_apply_in_progress` result** (not a generic error, not a 500-class crash). Tests pin this exact code so operator tooling and CI can detect the race deterministically.
- The CAS guard is symmetric: it protects against simultaneous CLI invocations, accidental daemon-loop replay (M6 does not loop external apply, but the guard still prevents it from being introduced later by accident), and any future automation.

## Comment-only default

Unless target Linear status mutation is **explicitly configured** for the adapter or the intent payload, an external apply posts a **Linear comment** and leaves Linear issue status unchanged.

- The default `intent_apply_policy` value `create_intents_only` does not allow external apply at all (M5 behavior; M6 keeps this default).
- The new `intent_apply_policy` value `external_apply_allowed` enables external apply. Even when enabled, the default external write is **comment-only**.
- Status mutation requires explicit per-adapter configuration in `MOMENTUM.md` (or, where applicable, in the intent payload). Comment-only stays the default for any configuration short of an explicit status-mutation opt-in.
- Comment-only means: post a Linear comment carrying the operator reason and the idempotency marker. The Linear issue's `state` / `assignee` / `labels` / `project` / `milestone` are not touched.

## Idempotency marker

Every external write carries a **stable, documented idempotency marker** that the dedupe, post-apply reconcile, and recovery paths all key off of.

- The marker is composed from `(adapter_kind, intent_id, intent_payload_hash)` so the same intent applied twice (even after a crash) is detectable from Linear-side artifacts alone.
- The marker is included in the Linear comment body (or, when configured, in the structured comment metadata) so an operator can grep Linear for a Momentum-written comment without consulting the local store.
- The post-apply single-issue reconcile (NGX-301) uses the marker to confirm whether the comment / status mutation Momentum intended is already present on the issue.
- The marker shape is pinned by NGX-300 (M6-05) and asserted in tests.

## Post-apply single-issue reconcile

After a successful external write + finalize, the runtime performs a **single-issue reconcile** scoped to the touched Linear issue:

- The reconcile reads the single Linear issue (no list, no project-wide pagination), confirms the idempotency marker is present, and refreshes the local SourceItem snapshot for that issue.
- The reconcile is intentionally narrow: a manual operator-triggered apply must not cause a broad reconciliation run as a side effect. Broader reconciliation is still operator-triggered via `source reconcile linear`.
- A failed single-issue reconcile does **not** revert the apply (Linear is mutated; the local record is the authoritative durable trace). It surfaces a warning on the apply response and through `status` / `handoff`.

## Test guard: no real api.linear.app calls

Tests and smoke **must not** make real `api.linear.app` calls. The contract is:

- The M5 Linear reconciliation tests already use an in-process mock GraphQL endpoint (`test/cli-source-reconciliation.test.ts`, the smoke fixture). M6 extends that pattern for the write client.
- The M6 write client must accept an injectable endpoint and HTTP client so unit tests and smoke tests target the local mock endpoint deterministically.
- CI must remain safe to run against a fresh checkout with no Linear credentials. A test that hits the real Linear host is a contract violation and must fail review.
- Any future "live smoke" path must be **opt-in** via an explicit env var and must be excluded from the default test suite; it stays out of NGX-295..NGX-302.

## Operator surfaces and auditability

NGX-299 (M6-03) lands operator surfaces **before** NGX-298 (M6-04) lands the real write path. The operator surfaces include:

- `intent get` surfaces the audit row, the resolved external target, the comment-vs-status decision, the idempotency marker the runtime would write, and the current apply state (including `pending` / `in-flight` / `applied` / `blocked` / `skipped` / `canceled`).
- `intent list` surfaces a `blocked` filter so operators can see every intent that needs manual clearance.
- `status` and `handoff` surface a `blocked` count and an inline pointer to the most recent `blocked` intent for the goal.
- `doctor --json` surfaces an aggregate count of `blocked` intents across the data dir.
- `project status` surfaces `blocked` intents in the rollup with a distinct next-action hint above `review_pending_intents`.

The audit-before-apply ordering is reinforced at the operator surface level: an operator can inspect every audit field before running `intent apply --external-apply`, because all of those fields are written by the audit step or are derivable from the intent payload alone.

## Pre-existing contracts this apply path must not break

- The M5 `update_intents` schema: `pending` → `applied` / `skipped` / `canceled` transitions, the idempotency keys, the reason tracking, and the error metadata columns all remain wire-stable. M6 extends the schema; it does not rename or reshape it.
- `intent apply` without `--external-apply` continues to behave exactly as in M5 (manual operator mark, no external write).
- `intent skip` and `intent cancel` are unchanged.
- The `MOMENTUM.md` `intent_apply_policy` key keeps its M5 values (`create_intents_only` default, `external_apply_allowed` forward-compatible) and gains the runtime semantics described above.
- All M3 daemon / recovery contracts, M4 runner / policy contracts, and M5 source / evidence / intent contracts remain preserved verbatim.
