# Milestone 6: Policy-Gated External Apply

**Status:** Complete (NGX-295 through NGX-302). NGX-302 flipped the `doctor --json` milestone marker to the M6 closeout string `Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete`; NGX-319 (M7-07) later flipped it forward to the M7 closeout marker, NGX-330 (M8-07) advanced it to the M8 closeout string, and NGX-353 (M10-09) advanced the current marker to the M10 closeout string. The M6 contract surfaces themselves remain wire-stable.

Milestone 6 turns the durable `update_intents` rows from M5 into **policy-gated external writes against Linear**. M6 adds a real external write path through a single, explicitly-trusted adapter without weakening any M3/M4/M5 safety contract. External apply remains operator-mediated: nothing in M6 makes Momentum write to an external tracker automatically.

The runtime invariants for the apply path itself live in [internal/contracts/intent-apply.md](../contracts/intent-apply.md). The source-adapter boundary that the write client extends lives in [internal/contracts/source-adapters.md](../contracts/source-adapters.md). Treat those two contract docs as the source of truth; the milestone doc here scopes and sequences the work.

## Milestone goal

Land a two-phase external apply path for the Linear source adapter so an operator can elevate a single `update_intents` row to a real external write, gated by `MOMENTUM.md` `intent_apply_policy: external_apply_allowed`, with an auditable claim / audit / write / finalize lifecycle, a blocked / non-replay state on partial failure, a stable `intent_apply_in_progress` concurrency result, a comment-only default, a stable idempotency marker shape, and a post-apply reconcile scoped to the single touched issue. Tests do not call the real `api.linear.app` host.

## Shipped issue order

The Linear milestone "Milestone 6: Policy-Gated External Apply" shipped in the following order (all closed):

1. **NGX-295 — M6-00 M6 contract, roadmap, and docs setup** *(done)*: reshaped the public docs surface so README is the OSS front door, AGENTS is a compact agent contract, and the M6 invariants live in `internal/`.
2. **NGX-296 — M6-01 ExternalUpdateAdapter boundary and result taxonomy** *(done)*: added the write-side adapter boundary, registry, input/result types, deterministic dry-run preview shape, idempotency marker helper, and stable adapter/write error taxonomy. No real Linear mutations or CLI external apply integration in this slice.
3. **NGX-297 — M6-02 Linear external update client** *(done)*: introduced the credential-handling Linear GraphQL mutation client behind the adapter boundary. Tests use mock fetch/endpoints; **no real `api.linear.app` calls**.
4. **NGX-299 — M6-03 Apply audit ledger and operator surfaces** *(done)*: landed durable audit/claim storage, the per-intent CAS guard with `intent_apply_in_progress`, blocked/audit-incomplete state representation, and operator-visible surfaces **before** any CLI external write could mutate Linear. NGX-299 merged before NGX-298.
5. **NGX-298 — M6-04 External apply execution** *(done)*: wired the two-phase external write behind `intent apply --external-apply`, gated on `intent_apply_policy: external_apply_allowed`. Comment-only by default; status mutation only when target Linear status mutation is explicitly configured.
6. **NGX-300 — M6-05 Post-apply reconciliation and mismatch resolution** *(done)*: refresh/reconcile of the touched Linear issue after a successful external write with stable reconciliation warning/result codes and no broad project reconciliation.
7. **NGX-301 — M6-06 External apply safety smoke and failure matrix** *(done)*: built-CLI smoke coverage for the complete safe external-apply path including policy-denied/default-safe behavior, auth failure, concurrency, idempotent replay, blocked/audit-finalize failure, comment-only mode, and mock-Linear guards.
8. **NGX-302 — M6-07 M6 docs, contract tests, and milestone closeout** *(done)*: closed the milestone, preserved older contracts, and flipped the `doctor` milestone marker to M6 complete.

**Ordering invariant honored: NGX-299 audit surfaces landed before NGX-298 external apply.** This is not a stylistic preference — it is a safety invariant. Operators could inspect every audit field that an external apply would write before any code path actually performed the write.

## Headline safety invariants

The full text lives in [internal/contracts/intent-apply.md](../contracts/intent-apply.md). The non-negotiable invariants are:

- **Two-phase apply.** `intent apply --external-apply` is a `claim → audit-before-write → external write → finalize` flow, not a single round-trip.
- **Audit-before-apply.** The audit step must run and persist before any external write is attempted. If audit fails, the external write does not happen.
- **Blocked / non-replay state on partial failure.** If the external write succeeds but the audit-finalize step fails, the intent transitions to a `blocked` non-replay state. A retry must not re-issue the external write; only an operator-driven recovery clears `blocked`.
- **Per-intent concurrency guard with stable result.** A compare-and-swap (CAS) on the per-intent apply state guarantees only one in-flight external apply per intent. Concurrent apply attempts return a stable `intent_apply_in_progress` result instead of racing.
- **Comment-only default.** Unless target Linear status mutation is explicitly configured (in `MOMENTUM.md` policy or per-intent payload), an external apply posts a Linear comment and leaves issue status unchanged.
- **Idempotency marker.** Every external write carries a stable, documented idempotency marker shape. Dedupe, post-apply reconcile, and any retry path key off that marker.
- **Single-issue post-apply reconcile.** Reconciliation after an external write is scoped to the single touched Linear issue; M6 does not trigger a broader reconciliation run as a side effect of an apply.
- **Tests / smoke must not make real api.linear.app calls.** Local mock endpoints only; CI must remain safe to run against a fresh checkout with no Linear credentials.

## M6 non-goals (explicit)

The following are explicitly out of scope for Milestone 6 and remain deferred regardless of how far M6 advances:

- **Inbound webhooks** — adapters stay pull / reconcile first; Momentum does not expose an HTTP listener in M6.
- **Dashboard or UI surface** — CLI JSON / text remains the only interface in M6.
- **Autonomous external writes** — every external write is operator-triggered through `intent apply --external-apply`, gated by `intent_apply_policy`. No background timer, daemon loop, or reconciliation pass writes externally.
- **non-Linear adapters** — GitHub / Jira / other source-system external apply paths are not part of M6. M6 ships exactly one external write adapter (Linear).
- **Broader runner/sandbox changes** — `trusted-shell` and `acp` remain explicitly trusted; container / VM / seccomp isolation is not part of M6.
- **Per-source-item worktrees / parallel same-repo Goals.**
- **Background runner supervision** (forking, daemonization, restart-on-crash).
- **Cooperative mid-job cancellation / signal handling.**
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.

## M3 / M4 / M5 contracts preserved through M6

M6 did not break or rename any M3 / M4 / M5 surface. Specifically: the `daemon start` / `daemon stop` / `daemon status` / `recovery clear` CLI shapes, the `daemon_runs` / `repo_locks` / `goals.needs_manual_recovery` schema, stale-lease detection and startup-recovery, the manual-recovery `recovery.md` artifact + flag, the `RunnerAdapter` boundary and the `fake` / `trusted-shell` / `acp` runner profiles, the runtime `MOMENTUM.md` policy loader and its precedence rules, the SourceItem / source snapshot / reconciliation run / evidence record / update intent schemas from M5, and the `status` / `handoff` / `doctor` daemon, recovery, runner, policy, source, evidence, and intent fields all remain wire-stable.

NGX-302 flipped the `doctor --json` milestone string to the M6 closeout marker `Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete`. NGX-295..NGX-301 left the M5 closeout marker in place. NGX-319 (M7-07) later flipped the doctor marker forward to the M7 closeout string, NGX-330 (M8-07) advanced it to the M8 closeout string, and NGX-353 (M10-09) advanced the current marker to the M10 closeout string.

## Post-M6 deferrals

The following remain explicitly deferred after M6 closeout and stay deferred through Milestone 8 ([`m8-workflow-run-operator-controls.md`](m8-workflow-run-operator-controls.md)) unless a later milestone explicitly changes that boundary:

- **Inbound webhooks** — source adapters stay pull / reconcile first; Momentum still does not expose an HTTP listener.
- **Dashboard or UI surface** — CLI JSON / text remains the only interface.
- **Autonomous or background external writes** — external apply remains operator-mediated via `intent apply --external-apply` and `intent_apply_policy`.
- **non-Linear adapters** — only the Linear external write adapter shipped in M6; GitHub / Jira / other source-system external apply paths remain out of scope.
- **Per-source-item worktrees / parallel same-repo Goals.**
- **Background runner supervision** (forking, daemonization, restart-on-crash).
- **Strong sandboxing** — `trusted-shell` and `acp` stay explicitly trusted; container / VM / seccomp isolation is not part of M6.
- **Cooperative mid-job cancellation / signal handling.**
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.
