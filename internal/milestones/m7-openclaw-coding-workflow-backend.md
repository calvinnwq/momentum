# Milestone 7: OpenClaw Coding Workflow Backend

**Status:** Active / in flight. M7 is the next milestone after M6 closeout. The first runtime substrate slices have landed (the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema migration, the `WorkflowRun` identity columns, the pure state vocabulary plus transition reducer, the lease-aware `deriveWorkflowRunState`, and the `classifyWorkflowLease` freshness classifier). The first M7 CLI envelope (`workflow import`) and its built-CLI smoke coverage have shipped (NGX-314). The remaining M7 CLI envelopes (`workflow run start|status|list|approve|update-step|monitor`), additional built-CLI smoke coverage, and the `doctor --json` closeout marker flip are still pending; the `doctor --json` milestone marker therefore keeps the M6 closeout string `Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete` until the M7 closeout slice flips it forward. This document does not mark M7 as shipped.

Milestone 7 turns Momentum into the **durable run substrate for OpenClaw coding workflows**. The OpenClaw `coding-workflow-pipeline` skill (preflight → GNHF implementation → postflight → no-mistakes → merge cleanup → Linear refresh, plus Discord approval delivery and monitor cron) already composes the executors. M7 does **not** replace those engines. M7 owns the durable run record, step-state transitions, lease coordination, approval persistence, and evidence pointers that those engines currently keep in ad-hoc files plus in-memory shell sessions.

The motivating failure modes are documented below; the M7 contract eliminates them by moving the run-substrate responsibilities into Momentum SQLite while leaving the executors, monitor cron, Discord delivery, and approval-button UX inside `coding-workflow-pipeline`.

## Milestone goal

Land a durable `WorkflowRun` substrate, step-state lifecycle, approval persistence, lease coordination, and evidence pointer schema for OpenClaw coding workflows, exposed through Momentum CLI envelopes that the `coding-workflow-pipeline` skill scripts (`workflow_plan.py`, `monitor_bridge.py`, `monitor_runner.py`, `node_managed_dispatch.py`) and its trusted runtime bindings can call without losing in-flight state when a shell session, cron tick, or managed child dies.

Crucially, M7 is the **backend substrate** only. It does not replace `gnhf-runner`, `gnhf-postflight`, `harness-delegate`, `no-mistakes-pipeline`, `model-evidence`, or `project-progress-refresh`. It does not own Discord approval rendering, monitor cron scheduling, or no-mistakes harness/model policy selection. Those remain owned by the skill.

## Data ownership boundary

The M7 contract draws a single, sharp boundary between Momentum (the durable substrate) and `coding-workflow-pipeline` (the executors / orchestration UX).

**Momentum (M7) owns:**

- **`WorkflowRun` durable record** — one row per coding-workflow run. Fields: `runId` (stable, matches the existing `.agent-workflows/<runId>/` directory id), `repoPath`, `objective`, `issueScope` (Linear identifiers + optional batch id), `route` (implementation harness/model + quota route), `approvalBoundary` (current cumulative boundary), `skillRevision`, `source` (run origin), optional `sourceArtifactPath` pointer back to the originating plan artifact, the captured `planJson` body, `state`, `createdAt`, `updatedAt`, optional linked `goalId`, optional batch grouping fields.
- **`workflow_steps`** — durable step rows keyed by `(runId, stepId)` with stable `stepId` values matching the existing skill step names (see "Compatibility" below). Fields: `kind` (preflight / implementation / postflight / no-mistakes / merge-cleanup / linear-refresh), `state` (`pending` / `approved` / `running` / `succeeded` / `failed` / `skipped` / `blocked` / `canceled`), `order` (plan-position ordinal), `required` (whether the step gates required-chain closure), `startedAt`, `finishedAt`, `ledgerOffset` pointer, `resultDigest`, `errorCode`, `errorMessage`.
- **`workflow_approvals`** — durable approval rows keyed by `(runId, boundary)` mirroring the existing repo-local `approval-<boundary>.json` artifacts. Fields: `boundary` (`implementation` / `through-implementation` / `no-mistakes` / `through-no-mistakes` / `merge-cleanup` / `through-merge-cleanup` / `full`), `actor`, `phrase`, `approvalFilePath`, `artifactDigest` (digest of the approval JSON body so the durable row and the on-disk artifact agree), `recordedAt`, optional `dischargedAt` once the boundary has been consumed by step progress.
- **`workflow_leases`** — durable monitor / managed-step leases keyed by `(runId, leaseKind)`. Replaces the existing in-process TTL locks and in-memory shell sessions. Fields: `leaseKind` (`monitor` / `managed-step` / `dispatch`), `holder` (cron job id / dispatcher pid), `acquiredAt`, `expiresAt`, `heartbeatAt`, `releasedAt` (nullable; non-null marks a cleanly released lease exempt from stale-policy promotion), `stalePolicy` (`auto-release` / `manual-recovery-required`).
- **Evidence pointer rows** — extension of the existing M5 `evidence_records` table so artifacts emitted by the skill (`plan.json`, `ledger.jsonl`, `approval-*.json`, monitor snapshots) link back to the owning `runId` and `stepId`. M7 does not reshape `evidence_records`; it only adds optional `runId` / `stepId` columns (or a sibling join table) plus the new ingest paths.
- **Run-scoped recovery flag** — analogous to `goals.needs_manual_recovery`, a per-`WorkflowRun` `needs_manual_recovery` durable flag and recovery artifact (`recovery.md` under `.agent-workflows/<runId>/`) for the cases listed under "Old monitor failure modes" below.
- **CLI envelopes** that surface the above through stable JSON / text: `workflow run start|status|list|approve|update-step|monitor`, evolving the existing `evidence` / `intent` / `recovery` envelopes to expose run-scoped views. Exact CLI names and JSON shapes are pinned in follow-up M7 issues.

**`coding-workflow-pipeline` (skill) keeps owning:**

- Plan composition (`workflow_plan.py plan` / `batch-plan` / `update-step`).
- Approval UX and Discord delivery (`discord-envelope` + `approve-button`, button vs phrase routing, presentation reuse).
- Monitor cron scheduling (`coding-workflow-monitor:<runId>` cron creation, dedupe, TTL lock acquisition through `monitor_runner.py`).
- Managed-step dispatch (`node_managed_dispatch.py`, `bindings/managed_runner.mjs`, `bindings/tool_entrypoint.mjs`).
- Executor invocation (GNHF / postflight / no-mistakes / merge cleanup / Linear refresh scripts and the owning skills behind them).
- Quota route selection, no-mistakes harness/model policy, batch merge-gate policy, and skill-hardening / batch digest.
- Failure classification source of truth (`failure_patterns.yaml`) and recovery procedures (`references/recovery.md`).

The boundary keeps M7 narrow: Momentum is the durable substrate plus CLI envelopes. The skill stays the judgment router and the runtime.

## Old monitor failure modes M7 eliminates

The OpenClaw coding workflows currently rely on a mix of repo-local artifacts under `.agent-workflows/<runId>/`, monitor cron leases written to `monitor.json`, and in-memory shell sessions. M7's substrate elevates the artifacts into SQLite-backed durable rows so the following failure modes stop being reachable:

- **In-memory shell session loss.** Today, losing a Claude / Codex shell session mid-step can drop knowledge of run state because the in-progress invariants live in the chat turn. M7 pins all run / step / approval / lease state in SQLite; recovery does not depend on the shell.
- **Phase-suffixed cron leak.** The skill already mandates a single pipeline-level monitor cron (`coding-workflow-monitor:<runId>`), but legacy phase-suffixed jobs (`coding-workflow-monitor:<runId>:postflight`, etc.) still appear and must be hand-cleaned. M7 leases are run-scoped, so `monitor_runner.py --auto-cleanup-terminal-cron` can rely on the durable run state instead of scanning cron names.
- **Lost managed child before durable progress.** When `node_managed_dispatch.py` loses its detached child before any ledger event is written, the current contract requires `manual_recovery_required` because there is no durable record. M7 writes a `workflow_steps` row in `running` with a dispatch lease before the child is started, so a lost child is detectable from durable state and the lease's `stalePolicy` decides whether auto-release or manual recovery applies.
- **Monitor lease path drift.** The existing rule that monitor lease paths must stay under `.agent-workflows/<runId>/monitor.json` is enforced by skill code only. M7 stores leases in SQLite, so a stray lease file under a project source path (e.g., `.openclaw/runtime/bin/openclaw`) is no longer a possible artifact and the contract test surfaces it as a guard.
- **Approval reconstruction from prose.** Today the skill explicitly rejects `"go ahead"`-style approval phrases because there is no durable approval row. M7 makes approvals a durable `workflow_approvals` row keyed by run + boundary; the skill's `approve-button` and `discord-envelope` flow continues to be the entry point, but the row is the source of truth for status / watch / monitor envelopes.
- **Cron tick vs workflow tick conflation.** The skill currently distinguishes cron health from workflow health in prose. M7's durable `workflow_runs.updatedAt` + per-step `updatedAt` plus the lease heartbeat make `lastSeenDigest` vs `lastEmittedDigest` semantics persistable, so a successful cron tick observing unchanged workflow state simply observes the same digest.
- **Approval boundary drift between batches.** Batch mode (`batch-plan`) currently keeps per-item approvals in repo-local files. M7's `workflow_approvals` rows are run-scoped, and the optional batch grouping fields on `WorkflowRun` let `batch-final-cleanup` reconcile from durable state instead of from the file tree only.

The M7 contract is **not** to make any of those skill scripts disappear. The contract is to make their in-flight state survive shell death, cron drift, and dispatcher loss.

## Compatibility with existing artifacts

M7 must not break `coding-workflow-pipeline` runs in flight. Specifically:

- **`.agent-workflows/<runId>/plan.json`** stays the canonical plan artifact. M7 records a pointer to the plan path and the `skillRevision` it was captured with; it does not reshape the plan JSON or move it out of `.agent-workflows/<runId>/`.
- **`.agent-workflows/<runId>/ledger.jsonl`** stays the canonical append-only ledger emitted by the skill scripts. M7 captures a `ledgerOffset` pointer per step row and may opportunistically index ledger events into Momentum tables, but the JSONL file remains the source of truth for the skill scripts.
- **`.agent-workflows/<runId>/approval-<boundary>.json`** stays the canonical approval artifact. M7's `workflow_approvals` row stores `approvalFilePath` plus a digest of the file body so the durable row and the JSON artifact agree.
- **`.agent-workflows/<runId>/monitor.json`** stays the canonical TTL-locked monitor snapshot for the skill's monitor runner. M7's `workflow_leases` row mirrors the lease holder / TTL / heartbeat but does not replace `monitor.json`. The lease-path guard (`monitor.json` only under `.agent-workflows/<runId>/`) is unchanged.
- **Step names** stay stable: `preflight`, `implementation` (GNHF), `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`. The `workflow_steps.kind` taxonomy uses these names verbatim.
- **Approval boundary phrases** stay stable: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`. Batch boundaries (`plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch`) stay stable and map to per-item runs through the optional batch grouping fields on `WorkflowRun`.
- **Existing M5 evidence ingest paths** (`plan.json`, `ledger.jsonl`, `approval-*.json` under `.agent-workflows/<runId>/`, see [docs/evidence-commands.md](../../docs/evidence-commands.md)) keep working. M7 extends the schema so each ingested artifact can attach back to the owning `runId` and `stepId`, but the existing ingest CLI / refusal codes do not change shape in this contract slice.

The compatibility test guard for the M7 contract pins these artifact paths and step / boundary names so a later schema change cannot rename them without an explicit milestone slice.

## M7 non-goals (explicit)

The following are explicitly out of scope for M7 and remain deferred regardless of how far the milestone advances. They do not block M7 closeout and they must not creep into M7 implementation slices:

- **Dashboard or UI surface.** CLI JSON / text remains the only Momentum interface. Discord delivery for approvals stays inside the skill; Momentum does not render UI.
- **Inbound webhooks.** Momentum still does not expose an HTTP listener. Tracker reconciliation stays pull / reconcile first.
- **Autonomous or background external writes.** External apply remains operator-mediated through `intent apply --external-apply` and `intent_apply_policy` from M6. M7 does not introduce a code path that performs external writes outside that contract.
- **Replacing the GNHF / postflight / no-mistakes / merge-cleanup engines themselves.** M7 is the substrate, not the executor.
- **Replacing Discord approval delivery or monitor cron scheduling.** Those remain inside `coding-workflow-pipeline`.
- **Replacing `failure_patterns.yaml` or the skill's recovery classifier.** Momentum surfaces durable run / step / lease state; the skill continues to classify failure modes.
- **Parallel same-repo Goals or per-source-item worktrees.** A `WorkflowRun` continues to use one shared repo lease, consistent with the M3 single-workspace decision. Worktrees / parallel same-repo Goals stay deferred.
- **Strong sandboxing.** `trusted-shell` and `acp` remain explicitly trusted. M7 does not introduce container / VM / seccomp isolation.
- **Cooperative mid-job cancellation / signal handling.** `daemon stop` and `daemon stop --now` semantics from M3 remain wire-stable; M7 does not add a new in-process cancellation signal.
- **Remote git operations driven from Momentum.** No `fetch` / `pull` / `push` / `rebase` driven from Momentum.
- **Non-coding workflow runs.** M7's `WorkflowRun` is scoped to OpenClaw coding workflows. Generalizing the substrate to other run shapes is deferred until a later milestone justifies it.

## Planned M7 issue order

M7 began as a docs / contract slice (NGX-312) and is now extending into runtime substrate slices under the "Milestone 7: OpenClaw Coding Workflow Backend" project milestone. The implementation issues are listed for sequencing context; M7 as a whole is **not** complete and this document does not claim otherwise.

1. **NGX-312 — M7-00 Contract, roadmap, and docs setup** *(complete)*: pinned the M7 contract, ownership boundary, old monitor failure modes, compatibility list, and non-goals. No runtime schema or CLI implementation in this slice.
2. **NGX-313 — M7-01 WorkflowRun substrate schema and state model** *(in flight)*: ships the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` schema migration, the `WorkflowRun` identity columns (`repo_path`, `objective`, `issue_scope_json`, `route_json`, `approval_boundary`, `skill_revision`), the pure run / step state vocabulary and transition reducer, the lease-aware `deriveWorkflowRunState`, and the `classifyWorkflowLease` lease-freshness classifier. No CLI surface in this slice.
3. **NGX-314 — M7-02 Import current agent-workflow plans** *(in flight)*: ships the pure `.agent-workflows/<run-id>/` normalizer (plan / ledger / approvals / advisory monitor) with the stable `evidence_format_unknown` / `evidence_format_invalid` diagnostic taxonomy, the SQLite persistence layer for the M7 substrate tables, the `momentum workflow import --path <run-dir> [--json]` CLI envelope (see [docs/workflow-commands.md](../../docs/workflow-commands.md)), and built-CLI smoke coverage for happy-path import, idempotent re-import, terminal-ledger-wins-over-stale-monitor, lost managed-task markers, discharged / pending approvals, malformed-plan tolerance, `runId` fallback from `plan.json`, JSON envelopes, and the `path_required` / `import_path_unreadable` refusals.
4. **Future M7 implementation slices** *(not yet sequenced in this document)*: evidence pointer extension, the run-scoped recovery flag, the remaining M7 CLI surface (`workflow run start|status|list|approve|update-step|monitor`), additional built-CLI smoke coverage against the skill scripts, and the M7 closeout that flips the `doctor --json` milestone marker forward.

Concrete issue identifiers and sequencing for the remaining implementation slices will be added to this document as those issues are opened in Linear.

## M3 / M4 / M5 / M6 contracts preserved through M7

M7 must not break or rename any M3 / M4 / M5 / M6 surface. Specifically, the `daemon start` / `daemon stop` / `daemon status` / `recovery clear` CLI shapes, the `daemon_runs` / `repo_locks` / `goals.needs_manual_recovery` schema, stale-lease detection and startup-recovery, the manual-recovery `recovery.md` artifact + flag, the `RunnerAdapter` boundary and the `fake` / `trusted-shell` / `acp` runner profiles, the runtime `MOMENTUM.md` policy loader and its precedence rules, the SourceItem / source snapshot / reconciliation run / evidence record / update intent schemas from M5, the M6 two-phase external apply contract (see [internal/contracts/intent-apply.md](../contracts/intent-apply.md)), and the `status` / `handoff` / `doctor` daemon, recovery, runner, policy, source, evidence, and intent fields all remain wire-stable.

## Closeout marker policy

The `doctor --json` milestone string stays at the M6 closeout marker until an explicit M7 closeout slice flips it forward. Pinning the M7 active marker (this issue and the active-marker contract test) does **not** flip the doctor string. A future M7 closeout slice will own that change.
