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
- `test/smoke.test.ts` is the dominant single file.
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

`test/smoke.test.ts` is still the highest-value integration artifact because it
pins the real built CLI against SQLite-backed orchestration. It also carries
many historical milestone proofs in one huge file.

Duplication pattern:

- Lower-level contract tests already pin many reducer, import, monitor, and
  renderer shapes.
- `test/smoke.test.ts` often re-proves the same invariant through the full CLI.

Action:

- NGX-431 should split this file into milestone- or behavior-scoped smoke files.
- Preserve coverage in `pnpm test:integration`.
- Do not reduce evidence until the regression matrix names the replacement
  smoke file for each row.

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

