# Contract: Source Adapters

**Status:** Active. Captures the boundary that landed in M5 (NGX-288..NGX-294) and the read-only invariants that M6 must preserve while it adds the policy-gated external write path described in [internal/contracts/intent-apply.md](intent-apply.md).

A **source adapter** is the read / list / get / normalize boundary for an external source system (Linear, GitHub, Jira, etc.). Adapters are analogous to `RunnerAdapter`: they wrap an external runtime behind a stable, typed boundary so Momentum core does not couple to any single vendor.

## Read-only contract

- Source adapters in M5 are **read-only**. They read external state and write only to Momentum's local durable tables (snapshots, SourceItems, reconciliation runs).
- Source adapters **do not** own Goal / Iteration / Job state.
- Source adapters **do not** touch git.
- Source adapters **do not** perform automatic external writes. External writes are represented as durable, policy-gated `update_intents` rows. In M5 those intents are never applied externally. In M6 they may be applied through the two-phase apply path documented in `intent-apply.md`, gated by `MOMENTUM.md` `intent_apply_policy: external_apply_allowed`.
- The read / write split is preserved through M6: M6's Linear write client is a **separate** code path layered on top of the read adapter. The read adapter stays read-only; the write client is the new surface and is invoked only through `intent apply --external-apply`.

## Inputs the adapter is allowed to take

- Operator-controlled config (Linear project / milestone filters, page size, endpoint override for tests).
- Credentials supplied via env vars or operator-controlled config paths. **Credentials never enter Momentum durable state or docs.**
- Test endpoints (for unit tests and smoke). The M5 Linear reconciliation tests already use an in-process mock GraphQL endpoint; M6 extends that pattern for the write client.

## Outputs the adapter writes

- `source_items` — normalized SourceItem rows with stable identity fields (adapter kind, external id, external key, URL, title, status, metadata JSON, last observed timestamp, optional linked Goal id).
- `source_snapshots` — durable raw state captured per SourceItem per observation. Snapshots feed reconciliation and provide an audit trail for drift detection.
- `source_reconciliation_runs` — per-invocation rows recording started / finished timestamps, adapter kind, input filters, state, top-level error, `items_seen` / `items_upserted` counts, pagination-stop metadata, and created / updated / skipped / errored counts with sampled per-item errors.

## Failure taxonomy

Source adapters surface failures through a stable taxonomy so operator tooling can detect deterministically.

- Auth / credential failures: `auth_failed`.
- Rate-limit / transport failures: `rate_limited`, `transport_failed`.
- Pagination / response-shape failures: `pagination_invalid`, `response_invalid`.
- Per-item normalization failures are sampled into the reconciliation-run error column rather than aborting the run.

`source reconcile linear --dry-run` exercises the adapter without writing snapshot / SourceItem rows so operators can validate connectivity and filter scope safely.

## Composition with existing Momentum contracts

- **Goal / Iteration / Job** remain the durable execution units. SourceItems link into Goals optionally; the Goal is still the completion authority.
- **RunnerAdapter** and the existing runner profiles (`fake`, `trusted-shell`, `acp`) keep their M4 contract; source context is threaded through prompt rendering only.
- **daemon** start / stop / status, the managed loop, stop / stop-now semantics, and stale-lease recovery from M3 remain wire-stable. Reconciliation runs and evidence ingestion are explicit CLI operations, not daemon-loop side effects.
- **recovery** flags, `recovery.md`, and `recovery clear` from M3/M4 stay unchanged.
- **handoff** JSON / markdown grows new optional fields for linked source context, recent reconciliation summary, evidence summaries, and pending update intents. Existing M2–M4 fields are preserved.

## What M6 adds on top of this boundary

M6 introduces a write-side adapter boundary and Linear write client behind `intent apply --external-apply`. The boundary/client path:

- Starts with the NGX-296 `ExternalUpdateAdapter` boundary: registry, input/result types, deterministic dry-run preview, idempotency marker helper, and stable adapter/write error taxonomy with no mutation capability.
  - The NGX-296 built-in registry contains exactly the Linear external update adapter, reported as `{ kind: "linear", supportedIntentTypes: ["source_satisfied"] }`. No other update intent types are externally applicable until a later slice explicitly adds support.
  - The adapter input envelope contains the pending `intent`, resolved `target`, optional `sourceItem` and `evidenceRecord` context, `operator.reason` plus optional `operator.actor`, and policy metadata (`intentApplyPolicy`, `allowStatusMutation`). Preview refuses unsupported adapters or intent types, policy other than `external_apply_allowed`, missing target ids, empty operator reasons, and target / intent mismatches with stable error results.
  - The stable write-side error taxonomy is `unsupported_adapter`, `unsupported_intent_type`, `target_missing`, `target_state_ambiguous`, `auth_unavailable`, `policy_denied`, `external_conflict`, `adapter_threw`, `write_rejected`, `write_timeout`, `malformed_response`, and `validation_failed`. Reconciliation-specific result codes are owned by NGX-300 and are intentionally excluded from this adapter taxonomy.
  - A successful dry-run preview returns `ok: true` with a `preview` envelope containing `adapterKind`, `intentId`, `intentType`, `target`, `mutationKind`, `summary`, `commentBody`, and `idempotencyMarker`. The stable `mutationKind` values are `comment` and `status_transition`; NGX-296 Linear previews return `comment` under the comment-only default. Failures return `ok: false`, `code`, and `error`, and the preview dispatcher must not throw.
- Adds the NGX-297 Linear external update client behind the adapter boundary. The client owns credential-handling GraphQL writes only: callers supply the preview/comment body/idempotency marker and optional status mutation config, and the CLI path remains unwired until NGX-298.
  - Comment-only remains the default. Status mutation is opt-in and resolves the target Linear workflow state deterministically by explicit id or by exact name within the target issue's team; missing, duplicate, or teamless name resolution returns `target_state_ambiguous` instead of guessing.
  - Before issuing a new comment mutation, the client scans the issue's existing comments for the stable idempotency marker and returns the existing comment as already applied when found. If a status mutation was explicitly requested, it may still transition the issue after marker detection.
  - The client maps auth, target lookup, ambiguity, transport/GraphQL rejection, timeout/network, malformed response, validation, and thrown-adapter failures to stable result codes. Partial failures may include the issue and/or comment references already produced.
  - Tests inject mock fetch/endpoints and guard against real `api.linear.app` calls.
- Lives behind `intent_apply_policy: external_apply_allowed` in `MOMENTUM.md` policy.
- Is gated by the two-phase claim / audit / write / finalize flow documented in [intent-apply.md](intent-apply.md), including the per-intent CAS guard, the blocked / non-replay state, the comment-only default, the stable idempotency marker, and the single-issue post-apply reconcile.
- Must not be called from any code path other than the M6 apply flow. In particular, the M5 reconciliation orchestrator stays read-only.

See [internal/milestones/m6-external-apply.md](../milestones/m6-external-apply.md) for the M6 scope and sequencing, and [intent-apply.md](intent-apply.md) for the apply-path safety invariants.
