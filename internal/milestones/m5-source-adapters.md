# Milestone 5: Source Adapters and Evidence Sync

**Status:** Complete (NGX-287 through NGX-294).

Milestone 5 made Momentum source-and-evidence aware while preserving the M4 runner contract and the M3 operational-safety surface. M5 is **durable intents and source adapters**, **not** external apply: source adapters read, the local SQLite store records durable update intents, and any external write stays operator-mediated. External apply lands in M6.

## M5 vocabulary

Durable concepts introduced or formalized by M5; none of them rename or replace the M3/M4 primitives:

- **SourceItem** — a normalized record drawn from an external system (Linear issue, GitHub PR/issue, Jira ticket) with stable identity fields (adapter kind, external id, external key, URL, title, status, metadata JSON, last observed timestamp, optional linked Goal id). A SourceItem is **context**, not the completion authority for any Goal.
- **SourceAdapter** — the read / list / get / normalize boundary for a source system, analogous to `RunnerAdapter`. Adapters do not own Goal/Iteration/Job state, do not perform external writes in M5, and do not touch git.
- **source snapshot** — the durable raw state captured for a SourceItem at a point in time. Snapshots feed reconciliation and provide an audit trail for drift detection.
- **reconciliation run** — a single invocation of a source adapter that records started/finished timestamps, adapter kind, input filters, state, top-level error, `items_seen` / `items_upserted` counts, pagination-stop metadata, and created / updated / skipped / errored counts with sampled per-item errors.
- **evidence artifact** — a normalized record of execution evidence (plan files, ledgers, no-mistakes outputs, PR links, merge evidence, verification summaries) attached to Goals and/or SourceItems with stable identity, type, path/URL, source, timestamp, summary, and metadata JSON. Ingestion is idempotent.
- **external update intent** — a durable, auditable record of a desired external write (state change, comment, label edit, project update) targeting a specific adapter and external id. Intents include payload JSON, reason, linked Goal / SourceItem / evidence ids, status, created / applied / skipped timestamps, and error metadata.
- **project rollup** — a deterministic local computation grouping SourceItems by observed state, linked Goal state, evidence freshness, reconciliation freshness, and pending update intents, with explicit drift / mismatch surfacing.

## M5 trust boundary

M5 keeps Momentum's existing trust posture and tightens the source/intent surface:

- Source adapters are **read-only** in M5. They read external state and write only to Momentum's local durable tables (snapshots, SourceItems, reconciliation runs).
- External writes are represented as durable, policy-gated **external update intents**. Generating an intent is not the same as applying it. Momentum does **not** perform automatic external writes in M5; M5 refused `intent apply --external-apply`, and M6 owns the gated external write path.
- Applying an intent in M5 is a manual operator mark via `intent apply` (without `--external-apply`), `intent skip`, or `intent cancel`, each requiring `--reason`.
- Credentials never enter Momentum durable state or docs. Source adapters accept credential paths / env vars through operator-controlled config only.
- Evidence ingestion reads local artifacts under operator-controlled paths (such as `.agent-workflows/`); Momentum does not scrape chat or external systems for evidence.
- Iteration prompts may carry source / evidence context, but policy notes from `MOMENTUM.md` and source context are **context-only**: they cannot override Momentum safety contracts (no commits, no pushes, no staged changes, runner / verification / git transaction boundaries).

## M5 composition with existing contracts

- **Goal / Iteration / Job** remain the durable execution units. SourceItems link into Goals (optional linkage); the Goal is still the completion authority.
- **RunnerAdapter** and the existing runner profiles (`fake`, `trusted-shell`, `acp`) keep their M4 contract; source / evidence context is threaded through prompt rendering only, not the adapter input shape.
- **daemon** start / stop / status, the managed loop, stop / stop-now semantics, and stale-lease recovery from M3 remain wire-stable. Reconciliation runs and evidence ingestion are explicit CLI operations, not daemon-loop side effects.
- **recovery** flags, `recovery.md`, and `recovery clear` from M3/M4 stay unchanged; M5 does not auto-clear manual recovery and does not generate new recovery codes from source / evidence ingestion.
- **handoff** JSON / markdown grows new optional fields for linked source context, recent reconciliation summary, evidence summaries, and pending update intents. Existing M2–M4 fields are preserved.
- **MOMENTUM.md** stays the canonical repo policy file. M5 adds the optional `intent_apply_policy` key with defaults of `create_intents_only` (Momentum records intents but does not perform external writes) and the forward-compatible `external_apply_allowed` (reserved for M6).

## Planned M5 issue order

The Linear milestone "Milestone 5: Source Adapters And Evidence Sync" sequenced the work as (all closed):

1. **NGX-287 — M5-00 M5 contract, roadmap, and docs setup** *(done)*.
2. **NGX-288 — M5-01 SourceItem state model and adapter boundary** *(done)*: durable SourceItem / snapshot / reconciliation-run schema, `SourceAdapter` interface and registry, a built-in `local-fixture` adapter for tests, `source list` / `source get` CLIs, and SourceItem visibility in Goal status / handoff JSON and markdown.
3. **NGX-289 — M5-02 Linear source adapter read and reconciliation** *(done)*: read-only Linear reconciliation for configured project / milestone / issues, normalized SourceItem records, a `source reconcile linear` CLI, and durable reconciliation-run summaries surfaced through `source list`, `doctor`, and the reconciliation JSON output.
4. **NGX-290 — M5-03 Goal/source linkage and planning context** *(done)*: `source link` / `source unlink`, `goal start --from-source`, context-only `## Source context` prompt injection, linked-source visibility through `goal start --json`, `status`, `logs`, and `handoff`, and SourceItem count visibility in `doctor`.
5. **NGX-291 — M5-04 Workflow evidence artifact ingestion** *(done)*: durable `evidence_records` schema with `format_version` and stable `ingest_key` idempotency; a pure `.agent-workflows` artifact parser; idempotent `evidence ingest` and filterable `evidence list` CLIs; latest-evidence visibility through `status`, `logs`, `handoff`, and `doctor`.
6. **NGX-292 — M5-05 Project rollup and status surfaces** *(done)*: deterministic local rollup logic and a `project status` CLI that filters by source / project / milestone, applies reconciliation staleness thresholds, and surfaces mismatch categories, reconciliation warnings, pending-intent placeholders, and next-action hints from local state only.
7. **NGX-293 — M5-06 Policy-gated external update intents** *(done)*: durable `update_intents` schema (status transitions `pending` → `applied` / `skipped` / `canceled` with idempotency keys, reason tracking, and error metadata); `evaluateGoalForSourceSatisfiedIntent` generator; `intent list` / `intent get` / `intent apply` / `intent skip` / `intent cancel` CLIs with `--reason` required for transitions; M5 default-safe `--external-apply` refusal; `MOMENTUM.md` `intent_apply_policy` precedence resolution; `pendingUpdateIntents` visibility through `status`, `handoff`, `project status`, and `doctor`.
8. **NGX-294 — M5-07 M5 smoke, docs, and milestone closeout** *(done)*: built-CLI smoke coverage for empty data dirs, fixture Linear reconciliation through an in-process mock endpoint, `source link` carrying a reconciled SourceItem through `status` / `handoff` / `doctor`, queued-goal completion via daemon drain followed by workflow evidence ingest and `source link` triggering a `source_satisfied` intent with `--external-apply` refused and a manual-mark apply path, and `project status` populated with a `goal_done_source_not_done` mismatch plus a pending intent. The `doctor --json` milestone string is the M5 closeout marker.

## M5 non-goals (explicit)

External apply landed in M6, not M5. M5 generated durable intents only; it did not perform any external write. The following remained explicitly out of scope for M5 and are tracked as M6 (or later) work:

- **Automatic external tracker writes** — Linear / GitHub / Jira / etc. issue / PR creation, comments, status changes, label edits driven automatically from Momentum.
- **Inbound webhooks** — source adapters stay pull / reconcile first; Momentum does not expose an HTTP listener in M5.
- **Dashboard or UI surface** — CLI JSON / text remains the only interface in M5.
- **Per-source-item worktrees** / parallel same-repo Goals.
- **Background runner supervision** — forking, daemonization, restart-on-crash.
- **Strong sandboxing** — `trusted-shell` and `acp` remain explicitly trusted.
- **Cooperative mid-job cancellation / signal handling**.
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.

## M3 and M4 contracts preserved

M5 did not break or rename any M3 or M4 surfaces. The `daemon start` / `daemon stop` / `daemon status` / `recovery clear` CLI shapes, the `daemon_runs` / `repo_locks` / `goals.needs_manual_recovery` schema, stale-lease detection and startup-recovery, the manual-recovery `recovery.md` artifact + flag, the `RunnerAdapter` boundary and the `fake` / `trusted-shell` / `acp` runner profiles, the runtime `MOMENTUM.md` policy loader and its precedence rules, and the `status` / `handoff` / `doctor` daemon, recovery, runner, and policy fields all remain wire-stable.
