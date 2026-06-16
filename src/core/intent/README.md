# core/intent

Update-intent domain. This folder owns update-intent state and the policy-gated
external-apply path: update intent persistence, apply audit records, apply
execution, the external-write policy checks, and post-apply reconciliation. It
holds business/runtime behavior only — state, audit, policy decisions, and
execution orchestration — and does not parse CLI arguments or format output. The
concrete external-update integrations stay under `src/adapters/`.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. Names were normalized to the domain folder
(`intent-apply-audits.ts` → `apply-audits.ts`, `intent-apply-execute.ts` →
`apply-execute.ts`, `momentum-policy.ts` → `policy.ts`); `update-intents.ts` and
`post-apply-reconcile.ts` kept their names.

## Local structure

| Concern | Modules |
| --- | --- |
| Update intent state | `update-intents.ts` |
| Apply audit / execution | `apply-audits.ts`, `apply-execute.ts` |
| External-write policy | `policy.ts` |
| Post-apply reconciliation | `post-apply-reconcile.ts` |
