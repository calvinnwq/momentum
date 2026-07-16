# core/repo

Repo domain. This folder owns the repo-mutation and verification primitives that
guard a unit of repo work: repo guards, repo lease locks, the verification
runner, iteration finalization, and project rollup. It holds
business/runtime behavior only — guards, locks, git-state primitives, and
finalization policy — and does not parse CLI arguments or format output. Concrete
git transaction plumbing stays under `src/adapters/`.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. The redundant `repo-` prefix was dropped where
the folder now carries the domain (`repo-guard.ts` → `guard.ts`, `repo-locks.ts`
→ `locks.ts`); `iteration-finalize.ts`, `project-rollup.ts`, and
`verification.ts` kept their names. The retired goal-first lane's
`branch-manager.ts` is gone with its mechanism.

## Local structure

| Concern                | Modules                 |
| ---------------------- | ----------------------- |
| Guards / locks         | `guard.ts`, `locks.ts`  |
| Verification           | `verification.ts`       |
| Iteration finalization | `iteration-finalize.ts` |
| Project rollup         | `project-rollup.ts`     |

`locks.ts` keeps active repository ownership lease-based and fences heartbeat, release, and recovery transitions by the current holder and attempt when the caller supplies them.
Interrupted delegate recovery may take over an active lock only for the same repository, run, and deterministic dispatch job, either after lock expiry or after scheduler recovery proves the matching dispatch holder stale.
Compare-and-swap checks over the previous holder, attempt, and deadline prevent a concurrent or newer owner from being displaced.

`guard.ts` normally requires a clean worktree.
Its only dirty-worktree exception is prepared delegate-commit recovery: the current `HEAD` must equal the receipt base, the index must write the exact expected tree, and no unstaged or untracked changes may exist.
The delegate adapter still rechecks result evidence, commit intent, and repository ownership before creating the commit.

The step-finalization reconciliation seam is not
part of this mechanical regrouping; `iteration-finalize.ts` keeps its existing
behavior.
