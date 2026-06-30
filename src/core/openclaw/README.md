# core/openclaw

OpenClaw-specific runtime domain. This folder owns Momentum's local delivery
state and classification logic for the `openclaw supervise` command. It holds
business/runtime behavior only: turning a frozen `workflow run watch --once`
envelope into an OpenClaw delivery tick, deciding whether the host should emit,
formatting the host delivery intent, applying config-gated local auto-action
rules, and loading/saving the per-run suppression state and audit files.

## Local structure

| Concern | Modules |
| --- | --- |
| Supervisor tick and state | `supervisor.ts` |
| Config-gated local auto-actions and audit evidence | `auto-actions.ts` |
| Delivery intent mapping | `delivery-intent.ts` |

`supervisor.ts`, `auto-actions.ts`, and `delivery-intent.ts` do not parse CLI arguments, format
terminal output, post webhooks, wake external lanes, or remove external
monitors. The command orchestration lives in `src/commands/openclaw/`, the
JSON/text envelope lives in `src/renderers/openclaw.ts`, and the subprocess
adapter that invokes `workflow run watch --once --json` lives in
`src/adapters/openclaw-watch-runner.ts`.

State files are written under
`<data-dir>/openclaw-supervisor/<encoded-run-id>.json`, where the encoded file
name is `encodeURIComponent(runId)`.
Auto-action audit records are appended beside that state as
`<data-dir>/openclaw-supervisor/<encoded-run-id>.auto-actions.jsonl`.

## Boundaries

- Core modules here must not import `src/commands/*` or `src/renderers/*`.
- Renderers may import from this folder only with `import type`.
