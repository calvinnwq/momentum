# NGX-499 opt-in coding workflow dogfood

NGX-499 proves one Momentum-owned coding workflow before NGX-404 can change the
default route. The proof stays opt-in: CWFP remains the production default and
rollback path.

## Wrapper profile

Use the checked-in live-wrapper profile:

```bash
pnpm build
export MOMENTUM_LIVE_WRAPPER_PROFILE="$PWD/profiles/ngx-499-coding-workflow-live-wrapper.profile.json"
export MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG="$PWD/tmp/ngx-499-wrapper-config.json"
```

`MOMENTUM_LIVE_WRAPPER_PROFILE` tells `daemon start` to execute live-wrapper
owned workflow steps through local commands. The profile covers:

- `preflight`
- `implementation`
- `postflight`
- `no-mistakes`
- `merge-cleanup`

`linear-refresh` remains owned by the policy-gated `external-apply` lane.

## Wrapper command config

The profile calls `dist/adapters/coding-workflow-live-wrapper-cli.js`. That
wrapper loads `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG`, selects the current step
from `MOMENTUM_STEP_KIND`, runs the configured command, then synthesizes and
writes normalized `RunnerResult` JSON to `MOMENTUM_RESULT_PATH`. The child
command does **not** write the result file directly; it communicates success or
failure through its exit status.

Minimal config:

```json
{
  "steps": {
    "preflight": {
      "command": "/usr/bin/env",
      "args": ["bash", "-lc", "git status --short --branch && pnpm typecheck"],
      "cwd": "repo",
      "timeout_sec": 1800,
      "env_allow": ["PATH", "HOME"],
      "success_summary": "preflight passed",
      "key_changes_made": ["Verified repo state and typecheck."],
      "commit": { "type": "test", "subject": "verify preflight" }
    }
  }
}
```

Per-step config keys use snake_case:

- `command` — optional non-empty executable path/name. If omitted, the selected
  step writes `success: false` with `No command is configured...`.
- `args` — argv string array, default `[]`; use an explicit shell such as
  `bash -lc` when shell expansion is required.
- `cwd` — `repo` (default, requires `MOMENTUM_REPO_PATH`) or `iteration`
  (requires `MOMENTUM_ITERATION_DIR`).
- `timeout_sec` — positive integer seconds, default `900`. Timeout kills the
  configured command's process tree through the live-step process-group helper.
- `env_allow` — daemon environment names forwarded to the child command, default
  `[]`; the wrapper always forwards the Momentum runtime variables
  (`MOMENTUM_RUN_ID`, `MOMENTUM_STEP_ID`, `MOMENTUM_STEP_KIND`,
  `MOMENTUM_ATTEMPT`, `MOMENTUM_REPO_PATH`, `MOMENTUM_ITERATION_DIR`,
  `MOMENTUM_PROMPT_PATH`, and `MOMENTUM_RESULT_PATH`) when present.
- `success_summary` / `failure_summary` — optional summaries overriding the
  default command-exit summaries.
- `key_changes_made`, `key_learnings`, `remaining_work` — string arrays, each
  defaulting to `[]`; failed commands replace `remaining_work` with the standard
  fix-this-step message.
- `commit` — optional normalized commit intent; omitted values default to
  `test: complete <step>` for verification steps and `chore: complete <step>`
  for implementation / cleanup / refresh steps.

Command failures become a valid runner result with `success: false`. That gives
Momentum durable failed-step evidence instead of a stranded process-level
manual-recovery state. Missing wrapper config is treated as an empty `steps` map,
so the selected step also writes `success: false` for the missing command.
`test/coding-workflow-live-wrapper.test.ts` pins the checked-in profile shape,
config parsing, successful command execution, failure-result writing, missing
command evidence, and process-tree timeout cleanup.

## Dogfood shape

1. Build the CLI.
2. Start a non-`cwfp-*` workflow run for `NGX-499`.
3. Approve through Momentum's durable approval rows.
4. Run bounded daemon ticks with the live-wrapper profile env set.
5. Force one restart or reattach check.
6. Complete the real PR path through implementation, postflight, no-mistakes,
   merge cleanup, and Linear refresh.
7. Write the NGX-404 go/no-go note from the evidence.

Do not use this proof to flip defaults, retire CWFP, or remove `cwfp-*`
compatibility.
