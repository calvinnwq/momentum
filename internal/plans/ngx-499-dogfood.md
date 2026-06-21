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

The profile calls `dist/tools/coding-workflow-live-wrapper.js`. That wrapper
loads `MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG`, selects the current step from
`MOMENTUM_STEP_KIND`, runs the configured command, then writes the normalized
`RunnerResult` JSON to `MOMENTUM_RESULT_PATH`.

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

Command failures become a valid runner result with `success: false`. That gives
Momentum durable failed-step evidence instead of a stranded process-level
manual-recovery state. Missing wrapper config also writes `success: false`.

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
