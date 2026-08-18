# core/intent

Intent domain. This folder owns intent state and the policy-gated
external-apply path: intent persistence, apply audit records, apply
execution, the external-write policy checks, and post-apply reconciliation. It
holds business/runtime behavior only — state, audit, policy decisions, and
execution orchestration — and does not parse CLI arguments or format output. The
concrete external-update integrations stay under `src/adapters/`.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. Names were normalized to the domain folder
(`intent-apply-audits.ts` → `apply-audits.ts`, `intent-apply-execute.ts` →
`apply-execute.ts`, `momentum-policy.ts` → `policy.ts`); the durable intent
state module now lives in `intents.ts` (formerly `update-intents.ts`) and
`post-apply-reconcile.ts` kept its name.

## Local structure

| Concern                   | Modules                               |
| ------------------------- | ------------------------------------- |
| Intent state              | `intents.ts`                          |
| Apply audit / execution   | `apply-audits.ts`, `apply-execute.ts` |
| External-apply preflight  | `external-apply-preflight.ts`         |
| External-write policy     | `policy.ts`                           |
| Post-apply reconciliation | `post-apply-reconcile.ts`             |
