# core/repo

Repo domain. This folder owns the repo-mutation and verification primitives that
guard an iteration: repo guards, repo lease locks, branch management, the
verification runner, iteration finalization, and project rollup. It holds
business/runtime behavior only — guards, locks, git-state primitives, and
finalization policy — and does not parse CLI arguments or format output. Concrete
git transaction plumbing stays under `src/adapters/`.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. The redundant `repo-` prefix was dropped where
the folder now carries the domain (`repo-guard.ts` → `guard.ts`, `repo-locks.ts`
→ `locks.ts`); `branch-manager.ts`, `iteration-finalize.ts`, `project-rollup.ts`,
and `verification.ts` kept their names.

## Local structure

| Concern | Modules |
| --- | --- |
| Guards / locks | `guard.ts`, `locks.ts` |
| Branch management | `branch-manager.ts` |
| Verification | `verification.ts` |
| Iteration finalization | `iteration-finalize.ts` |
| Project rollup | `project-rollup.ts` |

The M9/M10 step-finalization reconciliation seam (RC-2, landed as NGX-480) is not
part of this mechanical regrouping; `iteration-finalize.ts` keeps its existing
behavior.
