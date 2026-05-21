# Momentum Roadmap

Momentum is built milestone by milestone. Each milestone has a single durable shape that lands in code, in docs, and in the `doctor` readiness marker before the next one starts. The roadmap below is the canonical timeline; deeper detail lives in each milestone doc under `internal/milestones/` and each cross-milestone contract under `internal/contracts/`.

## Timeline

| Milestone | Theme | Status | Detail |
|---|---|---|---|
| Milestone 1 | Foreground Proof Loop | Complete | See [README](../README.md) and milestone bullets in [AGENTS.md](../AGENTS.md) |
| Milestone 2 | Queue and Worker Model | Complete | See [README](../README.md) and milestone bullets in [AGENTS.md](../AGENTS.md) |
| Milestone 3 | Operational Safety | Complete | [m3-operational-safety.md](milestones/m3-operational-safety.md) |
| Milestone 4 | Real Runner Profiles | Complete | [m4-real-runners.md](milestones/m4-real-runners.md) |
| Milestone 5 | Source Adapters and Evidence Sync | Complete | [m5-source-adapters.md](milestones/m5-source-adapters.md) |
| Milestone 6 | Policy-Gated External Apply | Complete | [m6-external-apply.md](milestones/m6-external-apply.md) |

The `doctor` readiness marker tracks the **most recently closed** milestone. It currently reads `Milestone 6: policy-gated external apply (NGX-295, NGX-296, NGX-297, NGX-298, NGX-299, NGX-300, NGX-301, NGX-302) complete`. The next milestone, when scheduled, will flip the marker forward.

## Most recent milestone: M6

Milestone 6 shipped **policy-gated external apply**: a single concrete adapter (Linear) gained a two-phase external write path behind operator-mediated configuration. M5 already recorded durable update intents; M6 lets an operator turn an intent into a real external write while preserving every M3/M4/M5 safety contract.

The full M6 contract — runtime invariants, the two-phase apply flow, audit ordering, and the comment-only default — lives in [internal/contracts/intent-apply.md](contracts/intent-apply.md). The milestone-level scope, shipped sequencing, and post-M6 deferrals live in [internal/milestones/m6-external-apply.md](milestones/m6-external-apply.md).

### Shipped M6 implementation order

The Linear milestone "Milestone 6: Policy-Gated External Apply" shipped the work in the following order (all closed):

1. **NGX-295 — M6-00 M6 contract, roadmap, and docs setup**: reshaped the public docs surface so README is the OSS front door, AGENTS is a compact agent contract, and the M6 invariants live in `internal/`.
2. **NGX-296 — M6-01 ExternalUpdateAdapter boundary and result taxonomy**: added the write-side adapter boundary, registry, input/result types, deterministic dry-run preview shape, idempotency marker helper, and stable adapter/write error taxonomy. No real Linear mutations or CLI external apply integration in this slice.
3. **NGX-297 — M6-02 Linear external update client**: introduced the credential-handling Linear GraphQL mutation client behind the adapter boundary. Tests used mock fetch/endpoints; no real `api.linear.app` calls in tests.
4. **NGX-299 — M6-03 Apply audit ledger and operator surfaces**: landed durable audit/claim storage, the per-intent CAS guard with `intent_apply_in_progress`, blocked/audit-incomplete state representation, and operator-visible surfaces **before** any CLI external write could mutate Linear.
5. **NGX-298 — M6-04 External apply execution**: wired the two-phase external write behind `intent apply --external-apply` gated by `intent_apply_policy: external_apply_allowed`. Comment-only by default; status mutation only when explicitly configured.
6. **NGX-300 — M6-05 Post-apply reconciliation and mismatch resolution**: refreshed/reconciled the touched Linear issue after a successful external write and surfaced stable reconciliation warning/result codes without broad project reconciliation.
7. **NGX-301 — M6-06 External apply safety smoke and failure matrix**: added built-CLI smoke coverage for the complete safe external-apply path, including policy-denied/default-safe behavior, auth failure, concurrency, idempotent replay, blocked/audit-finalize failure, comment-only mode, and mock-Linear guards.
8. **NGX-302 — M6-07 M6 docs, contract tests, and milestone closeout**: closed the milestone, preserved older contracts, and flipped the `doctor` milestone marker to M6 complete.

NGX-299 landed before NGX-298 — audit surfaces shipped first so operators could see what an external apply would write before any real write could happen.

## Post-M6 deferred work

The following remain explicitly deferred until a future milestone justifies them:

- Inbound webhooks; source adapters stay pull / reconcile first.
- Dashboards or any UI surface; the CLI remains the only interface.
- Autonomous or background external writes; M6 external apply stays operator-mediated.
- Non-Linear external write adapters (GitHub / Jira / etc.).
- Per-source-item worktrees / parallel same-repo Goals.
- Background runner supervision (forking, daemonization, restart-on-crash).
- Strong sandboxing (container / VM / seccomp) for runner adapters.
- Cooperative mid-job cancellation / signal handling.
- Remote git operations (`fetch` / `pull` / `push` / `rebase`) driven from Momentum.
