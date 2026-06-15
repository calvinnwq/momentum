# Runtime and Test Weight Audit

Status: baseline for the Runtime/Test Weight Audit Cleanup milestone.

This audit is internal planning evidence. It maps the shipped runtime paths and
test gates after the Milestone 11 CLI architecture refactor, then separates
"required compatibility" from "cleanup candidate" before any production code or
coverage is removed.

## Input State

- Baseline branch: `feat/ngx-430-runtime-test-audit-baseline`
- Baseline source: `main` after PR #99, merge commit
  `1f57c9fffb3ac32cef70645113d7b14b8993a400`
- Package scripts:
  - `pnpm test`: fast Vitest lane, `vitest.fast.config.ts`
  - `pnpm test:integration`: heavy integration lane,
    `vitest.integration.config.ts`
  - `pnpm test:full`: fast lane followed by integration lane
- Contract inventory reviewed:
  - `ARCHITECTURE.md`
  - `internal/contracts/*`
  - `internal/milestones/*`
  - `internal/regression-matrix.md`
  - `internal/smoke-tests.md`
  - `internal/exclusions.md`

## Current Test Inventory

Post-M11 inventory:

- `test/**/*.test.ts`: 148 files
- Approximate total test lines: 101,022
- Process / CLI style test files: 45 files reference `runCli`,
  `execFileSync`, `execSync`, `spawnSync`, or `spawn(`
- Internal spec / contract reader tests: 17 files reference internal contract,
  milestone, regression, smoke-test, or architecture docs

Largest files by line count:

| File | Lines | Notes |
| --- | ---: | --- |
| `test/smoke.test.ts` | 9,647 | Built-binary milestone smoke; highest value and highest weight. |
| `test/cli.test.ts` | 6,495 | Broad CLI output compatibility coverage. |
| `test/goal-status.test.ts` | 2,517 | Broad goal/status compatibility coverage. |
| `test/handoff.test.ts` | 2,118 | Broad handoff compatibility coverage. |
| `test/live-step-orchestrator.test.ts` | 2,103 | M9 live-wrapper orchestration and lease behavior. |
| `test/cli-intents.test.ts` | 2,054 | Intent command coverage. |
| `test/stale-recovery.test.ts` | 1,962 | Daemon/recovery integration coverage. |
| `test/migrations.test.ts` | 1,901 | Schema migration coverage. |
| `test/daemon-loop.test.ts` | 1,881 | Daemon loop coverage. |
| `test/workflow-scheduler.test.ts` | 1,842 | Workflow scheduler coverage. |

## Timing Evidence

Commands were run locally on 2026-06-14 AEST from the Momentum repo.

Fast lane:

```text
pnpm vitest run --config vitest.fast.config.ts --reporter=json --outputFile=/tmp/momentum-fast-results.json
```

Result:

- Wall time: 5.154s
- Files / suites reported by Vitest JSON: 109 files, 555 suites
- Tests: 2,295 passed
- Failed tests: 0

Slowest fast-lane files:

| File | Time | Tests |
| --- | ---: | ---: |
| `test/cli-import-boundaries.test.ts` | 1.59s | 9 |
| `test/no-mistakes-orchestrator.test.ts` | 0.74s | 50 |
| `test/workflow-scheduler.test.ts` | 0.62s | 48 |
| `test/cli-intents.test.ts` | 0.61s | 59 |
| `test/project-rollup.test.ts` | 0.61s | 35 |
| `test/executor-loop-persist.test.ts` | 0.57s | 42 |

Integration lane:

```text
pnpm vitest run --config vitest.integration.config.ts --reporter=json --outputFile=/tmp/momentum-integration-results.json
```

Result:

- Wall time: 1:46.48
- Tests: 942 passed, 1 failed, 2 skipped
- Failing file: `test/live-step-orchestrator.test.ts`
- Failing case:
  `runLiveWorkflowStep continues heartbeating after a transient SQLite busy error`
- The same file passed immediately before the JSON run, and the exact failing
  case passed immediately afterward in isolation. Treat this as a timing-sensitive
  integration flake to address under NGX-433, not as evidence that the runtime
  path is dead.

Slowest integration files from the JSON run:

| File | Time | Tests | Status |
| --- | ---: | ---: | --- |
| `test/smoke.test.ts` | 29.03s | 54 | passed |
| `test/live-step-wrapper.test.ts` | 10.62s | 38 | passed |
| `test/live-step-advance.test.ts` | 7.18s | 20 | passed |
| `test/goal-status.test.ts` | 7.05s | 60 | passed |
| `test/single-shot-mechanism.test.ts` | 6.99s | 20 | passed |
| `test/cli.test.ts` | 6.38s | 152 | passed |
| `test/handoff.test.ts` | 4.24s | 41 | passed |
| `test/worker-run.test.ts` | 3.12s | 21 | passed |
| `test/iteration-job.test.ts` | 2.46s | 16 | passed |
| `test/foreground-iteration-trusted-shell.test.ts` | 2.41s | 8 | passed |
| `test/foreground-iteration.test.ts` | 2.04s | 17 | passed |
| `test/goal-loop-mechanism.test.ts` | 1.92s | 19 | passed |
| `test/live-step-orchestrator.test.ts` | 1.54s | 45 | flaky |

The old pre-M11 baseline had a single undifferentiated `pnpm test` gate around
38.9s wall time. PR #97 already made the important first cut: everyday
`pnpm test` now runs in about 5s, while the heavy lane remains explicit.
This milestone should focus on making the heavy lane easier to reason about,
less duplicated, and less flaky.

## NGX-431: Built-binary smoke split (complete)

`test/smoke.test.ts` — formerly the dominant integration file in the table
above — has been fully decomposed into milestone-scoped built-binary smoke files
and removed. Every resulting file matches the `test/*smoke.test.ts` glob, so it routes into
`pnpm test:integration` and stays out of the fast `pnpm test` lane with no config
change. The shared base scaffolding (CLI build, disposable repos, temp dirs,
binary spawns) lives in `test/helpers/smoke-harness.ts`, and the shared
workflow-run CLI helpers (fixture writer, ledger-driving loop, `workflow` JSON
envelope readers) used by the M7 e2e / M8 / M10 files live in
`test/helpers/workflow-smoke-harness.ts`; both are collected by neither lane.

Extracted files (each run rebuilds `dist/` once in `beforeAll`):

| File | Scope | Tests | Local time |
| --- | --- | ---: | ---: |
| `test/m1-smoke.test.ts` | M1 CLI surface (doctor, help, status, handoff, usage) | 15 | 2.84s |
| `test/m2-smoke.test.ts` | M2 queued goal_iteration end-to-end | 4 | 2.45s |
| `test/m3-smoke.test.ts` | M3 daemon drain end-to-end | 5 | 2.70s |
| `test/m4-smoke.test.ts` | M4 real-runner end-to-end (trusted-shell, MOMENTUM.md policy, acp) | 4 | 2.21s |
| `test/m5-smoke.test.ts` | M5 evidence + intent + project-status end-to-end (NGX-294) | 8 | 3.43s |
| `test/m6-smoke.test.ts` | M6 policy-gated external apply end-to-end (NGX-301) | 8 | 10.51s |
| `test/m7-import-smoke.test.ts` | M7 workflow import end-to-end (NGX-314) | 5 | 1.31s |
| `test/m7-e2e-smoke.test.ts` | M7 end-to-end coding workflow (NGX-318) | 2 | 1.85s |
| `test/m8-smoke.test.ts` | M8 operator-control end-to-end (NGX-330) | 2 | 2.14s |
| `test/m10-smoke.test.ts` | M10 production workflow-lane dispatch (NGX-367) | 1 | 1.40s |

Timings measured 2026-06-15 AEST via
`pnpm exec vitest run --config vitest.integration.config.ts <file>`. Coverage is
unchanged: 15 + 4 + 5 + 4 + 8 + 8 + 5 + 2 + 2 + 1 = 54 tests, matching the pre-split
total in the integration table above. `test/m6-smoke.test.ts` remains the
high-water mark at 10.51s local (~17s on the NGX-431 reference class at ~1.6x,
under the 20s acceptance threshold); every milestone smoke file is now well under
20s on the slow class. M7-import (NGX-314) is read-only `workflow import` coverage
backed by its own self-contained `writeM7WorkflowImportFixture` fixture with no
dependency on the shared workflow-CLI helper set, so it extracted cleanly at
1.31s. The M7 e2e (NGX-318) carve first lifted the shared workflow-run CLI helper
set (`importWorkflowRun`, `workflowStatusJson`, `workflowHandoffJson`,
`workflowRunListJson`, `workflowRunMonitorJson`, `driveStepWithFakeExecutor`,
`appendLedgerEvent`, `E2E_STEPS`, `writeM7EndToEndFixture`) into the new
`test/helpers/workflow-smoke-harness.ts`, then moved the two M7 e2e tests into
`test/m7-e2e-smoke.test.ts`. The final carve then split the last two blocks out
of the monolith: M8 operator controls (NGX-330) into `test/m8-smoke.test.ts`
(2 tests / 2.14s) and M10 production dispatch (NGX-367) into
`test/m10-smoke.test.ts` (1 test / 1.40s), both importing the shared harness, and
deleted the now-empty `test/smoke.test.ts`. The closeout doc pass repointed the
`internal/regression-matrix.md` rows, the `internal/smoke-tests.md` targeted
commands, and the `test/m7-contract.test.ts` evidence-owner gate to the new
per-milestone files.

## NGX-433: Timeout/process-kill fixture centralization (complete)

The duplicated child-process timeout, descendant-kill, and process-group
cleanup scaffolding flagged in the "Timeout And Process-Kill Proofs" note below
has been centralized into `test/helpers/process-kill-harness.ts`, which exports
two timing primitives:

- `waitMs(ms)` — a synchronous `Atomics.wait` thread-blocking wait, used to pace
  heartbeat/lease probes and to let a backgrounded "survivor" descendant reach
  its marker window before a kill proof checks it.
- `sigtermImmuneSleep(sleepSec)` — the `trap "" TERM; sleep N` shell fragment
  that forces a mechanism to escalate past SIGTERM (to SIGKILL or a
  process-group kill) to stop the child.

Consumers are `test/live-step-wrapper.test.ts`,
`test/single-shot-mechanism.test.ts`, and
`test/live-step-orchestrator.test.ts`; the helper itself is pinned by the
fast-lane `test/process-kill-harness.test.ts` with no real spawn. The
mechanism-specific descendant-survivor fragments (single-shot's nohup+touch vs
live-wrapper's subshell+printf) were deliberately left inline so each suite
keeps its own SIGHUP / process-group intent visible, and the
`test/live-step-advance.test.ts` worker-script `Atomics.wait` string literals
(source embedded into temp worker files, not real waits) were left untouched.

`test/foreground-iteration-trusted-shell.test.ts` — the fourth timeout
mechanism in the audit — keeps its timeout proof inline: it is a plain bounded
`sleep` terminated by the runner's own `timeout_sec`, sharing neither primitive,
so forcing it onto the harness would change what the proof asserts.

Pure taxonomy/decision constants that no longer need a real spawn moved to the
fast lane in `test/runtime-contract-taxonomy.test.ts` (the live-wrapper recovery
vocabulary, the 256 MiB output cap, and the trusted-shell `MOMENTUM_*` env
contract). Every runtime mechanism still has at least one real process-behavior
proof in `pnpm test:integration`.

The full-lane `live-step-orchestrator` heartbeat flake called out in the cleanup
sequence (NGX-433, item 4) was root-caused and fixed test-side in commit
`c8ad55f`: a worker-beat clobber race (the injected advance must wait for the
worker's first real beat, not the seed timestamp, because lease acquisition
already stamps the heartbeat) and a `SQLITE_BUSY` contention race (the in-process
heartbeat worker holds a write lock while the main thread reads, and `openDb`
sets no `busy_timeout`). The probes are now `SQLITE_BUSY`-tolerant and
synchronize on the worker's first beat; the file ran 60/60 clean in isolation
and contributes 0 failures across the full lane.

### Re-captured integration timing

Re-run locally on 2026-06-15 AEST:

```text
pnpm vitest run --config vitest.integration.config.ts \
  --reporter=default --reporter=json \
  --outputFile=/tmp/momentum-ngx433-integration.json
```

Result:

- Wall time: 91.36s (baseline `1:46.48` = 106.48s).
- Tests: 940 passed, 2 skipped, 0 failed across 48 files.
- `test/live-step-orchestrator.test.ts` passed clean, including the formerly
  flaky `continues heartbeating after a transient SQLite busy error` case — the
  baseline run recorded exactly this file as the single integration failure.

Timeout / process-kill files versus the baseline integration table above:

| File | Baseline | Post-NGX-433 | Notes |
| --- | ---: | ---: | --- |
| `test/live-step-wrapper.test.ts` | 10.62s | 9.88s | real timeout + descendant-kill proofs retained |
| `test/live-step-advance.test.ts` | 7.18s | 7.13s | worker-script `Atomics.wait` literals left untouched |
| `test/single-shot-mechanism.test.ts` | 6.99s | 6.65s | process-group kill proof retained |
| `test/foreground-iteration-trusted-shell.test.ts` | 2.41s | 2.27s | inline plain-`sleep` timeout proof |
| `test/live-step-orchestrator.test.ts` | 1.54s (flaky) | 1.60s | now stable |

The timeout/process-kill files are flat-to-slightly-faster: removing the
duplicated scaffolding did not add per-file cost, and no real process proof was
weakened. The ~15s lane reduction is within run-to-run variance and also
reflects the earlier NGX-431 smoke split; the durable NGX-433 outcome is
qualitative — the heavy lane is now deterministic (1 failure at baseline, 0
now), with the timing primitives centralized and the pure taxonomy checks moved
off the real-timeout path.

## Runtime Path Classification

### Keep: Current Required Paths

These are not cleanup candidates yet:

- `src/index.ts -> src/cli.ts -> src/commands/*` remains the M11 command
  contract. `src/cli.ts` still deliberately owns top-level parsing plus
  daemon, recovery, worker, and doctor compatibility surfaces.
- Goal-first CLI compatibility remains required. It backs existing operator
  commands and the `goal-loop` executor family.
- Workflow-first runtime objects remain required:
  `WorkflowDefinition`, `WorkflowRun`, `StepDefinition`, `StepRun`,
  `ExecutorDefinition`, `ExecutorInvocation`, and `ExecutorRound`.
- M7/M8 workflow import, status, handoff, run approval, update-step,
  clear-recovery, monitor, and evidence-linkage surfaces remain required for
  compatibility with existing `.agent-workflows/cwfp-*` runs.
- M9 live wrappers remain required for managed live-step dispatch,
  finalization, result-file capture, lease behavior, and recovery artifacts.
- M10 executor-loop adapters remain required for workflow-first dispatch and
  future executor families.
- External adapter safety paths remain required:
  - Linear source reads stay read-only by default.
  - External apply remains policy-gated.
  - Real Linear / workflow harness smoke stays opt-in.

### Keep But Consolidate Later

These are legitimate future consolidation areas, but removal needs a separate
proof issue:

- Goal-first status/logs/handoff paths can narrow only after workflow-first
  equivalents are complete and migration coverage proves compatibility.
- `.agent-workflows` import and `cwfp-*` compatibility can narrow only after
  old run recovery and workflow history import are explicitly retired.
- M9 live-wrapper direct `workflow_steps` advancement and M10 executor-loop
  finalization need a named boundary. Today they intentionally coexist:
  live wrappers finalize the step directly, while executor-loop adapters write
  invocation/round evidence.
- Fake workflow executors remain valuable for deterministic substrate smoke.
  They should not be confused with production executor support, but deleting
  them would remove cheap regression coverage.
- Production dispatch scaffold rows are required to avoid fabricated terminal
  evidence. Deleting the scaffold before landed adapters replace it would
  weaken recovery.
- `external-apply` and `subworkflow` are valid executor families that fail
  closed until dispatchable adapters land. The current fail-closed behavior is
  a product safety feature, not dead code.

### Defer: Removal Candidates Need New Contracts

Do not remove these until an issue lists the replacement proof:

- Goal-first top-level command compatibility.
- Imported historical workflow artifacts.
- Fake executor smoke paths.
- Dispatcher scaffold behavior for under-configured families.
- External write refusal and audit rows.
- Subworkflow fail-closed paths.

NGX-434 should own the consolidation plan and follow-up deletion sequence.

## Test Taxonomy

### Fast Unit And Contract Lane

Owned by `pnpm test`.

Purpose:

- Pure reducers, state derivation, schema/contract checks, command registry
  boundaries, renderer output contracts, adapter normalization, and fail-closed
  taxonomy.

Current state:

- Healthy. About 5s wall time.
- Keep this lane as the everyday development default.

Cleanup guidance:

- Move only pure taxonomy or projection checks into this lane when equivalent
  real process behavior remains covered in integration.
- Do not add child-process timeout or built-binary smoke coverage here.

### Heavy Integration Lane

Owned by `pnpm test:integration`.

Purpose:

- Built `dist/index.js` smoke.
- Broad CLI compatibility.
- Daemon, worker, repo lock, process, live wrapper, git transaction, migration,
  and workflow dispatch behavior.

Current state:

- Valuable, but heavy and occasionally timing-sensitive.
- The monolithic built-binary smoke has been split into milestone-scoped files
  under `test/*smoke.test.ts` (NGX-431). No single file dominates integration
  timing; `test/m6-smoke.test.ts` remains the slowest at ~10.5s local.
- Several broad CLI files overlap newer renderer/output contract tests.
- Live-step heartbeat timing can flake under full-lane load.

Cleanup guidance:

- Keep the heavy lane explicit.
- Split large smoke files by milestone or behavior.
- Deduplicate broad CLI assertions only after focused output contract tests
  preserve the same JSON fields, refusal codes, stdout/stderr routing, and text
  wording.
- Centralize timeout/process-kill fixtures without removing the last real
  process proof for each mechanism.

### Opt-In Real Smoke

Owned by env-gated tests such as real Linear and real workflow harness smoke.

Purpose:

- Prove real external seams when an operator explicitly opens the gate.

Current state:

- Correctly out of the default fast and integration gates unless env vars are
  set.

Cleanup guidance:

- Preserve the no-real-network default.
- Keep evidence under ignored paths.
- Do not turn opt-in real smoke into default CI work.

## Heavy Coverage Duplication Notes

### Built-Binary Smoke

> **Update (NGX-431, complete):** the monolithic `test/smoke.test.ts` described
> below has since been split into the milestone-scoped `test/*smoke.test.ts`
> files and removed — see the NGX-431 section above. The analysis below records
> the pre-split motivation.

The milestone-scoped `test/*smoke.test.ts` files are the highest-value
integration artifacts because they pin the real built CLI against
SQLite-backed orchestration. Before the NGX-431 split, they lived in a single
monolithic `test/smoke.test.ts` that carried many historical milestone proofs in
one huge file.

Duplication pattern:

- Lower-level contract tests already pin many reducer, import, monitor, and
  renderer shapes.
- The milestone-scoped smoke files sometimes re-prove the same invariant through
  the full CLI. This is expected for built-binary integration coverage; do not
  reduce it until the regression matrix names a replacement test for each row.

Action (completed):

- NGX-431 has split the monolith into milestone-scoped smoke files. Coverage
  stays in `pnpm test:integration`. The regression matrix and smoke-tests docs
  now point to the per-milestone files.

### Broad CLI Compatibility

Heavy files:

- `test/cli.test.ts`
- `test/goal-status.test.ts`
- `test/handoff.test.ts`
- `test/goal-logs.test.ts`

Duplication pattern:

- M11 introduced focused renderer and command-family contract tests.
- Broad CLI files still pin many public envelope details.

Action:

- NGX-432 should build a per-command coverage map before deleting assertions.
- Safe removals require a named focused test preserving each JSON/text contract.

### Timeout And Process-Kill Proofs

> **Update (NGX-433, complete):** the duplicated timeout/process-kill scaffolding
> described below has since been centralized into
> `test/helpers/process-kill-harness.ts`, pure taxonomy constants moved to the
> fast lane, and the orchestrator heartbeat flake root-caused and fixed — see the
> NGX-433 section above. The analysis below records the pre-centralization
> motivation.

Heavy files:

- `test/single-shot-mechanism.test.ts`
- `test/live-step-wrapper.test.ts`
- `test/live-step-advance.test.ts`
- `test/foreground-iteration-trusted-shell.test.ts`
- `test/live-step-orchestrator.test.ts`

Duplication pattern:

- Several tests spawn real child processes to prove timeout, descendant cleanup,
  repo-lock heartbeat, or process-group behavior.
- Some setup and taxonomy checks are duplicated around the real process proof.

Action:

- NGX-433 should extract shared test helpers where it reduces duplicated setup.
- Keep at least one real process behavior proof per runtime mechanism in the
  heavy lane.
- Move pure taxonomy checks to fast coverage only when the integration proof
  still exists.

## Recommended Cleanup Sequence

1. **NGX-430: Land this baseline audit.**
   - Scope: docs only.
   - Verification: `git diff --check`, `pnpm typecheck`, `pnpm build`,
     `pnpm test`.

2. **NGX-431: Split built-binary smoke.**
   - Goal: reduce the largest smoke file below the 20s target per split file,
     or document why a specific smoke stays above it.
   - No coverage removal.

3. **NGX-432: Deduplicate broad CLI coverage.**
   - Goal: remove or move duplicated assertions only after focused tests prove
     equivalent output contracts.
   - Re-capture heavy lane timing.

4. **NGX-433: Centralize timeout and process-kill fixtures.**
   - Goal: reduce duplicated setup and isolate timing-sensitive flakes while
     preserving real process behavior proofs.
   - The full-lane `live-step-orchestrator` heartbeat flake should be part of
     this issue.

5. **NGX-434: Plan runtime consolidation boundaries.**
   - Goal: write keep/deprecate/defer decisions and a follow-up sequence before
     deleting historical runtime paths.
   - No broad production code deletion in this milestone unless a branch is
     proven unreachable by tests.

## Non-Goals For This Milestone

- No default switch away from current compatibility paths.
- No real external writes.
- No deletion of runtime compatibility paths without a separate migration proof.
- No weakening of public CLI output contracts.
- No movement of real process-kill or built-binary smoke into the fast default
  lane.
- No broad product behavior changes.

