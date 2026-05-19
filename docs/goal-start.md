# `goal start` envelope spec

`momentum goal start` parses the goal spec and initializes (or resumes) durable
goal state under the resolved data directory, then branches on `--foreground`.

This page captures the full queued / foreground JSON envelope shapes, the
init-time validation taxonomy, the `MOMENTUM.md` policy block, and the
`--from-source` source-link behavior. The README keeps a compact pointer; the
section heading in the README's `## Commands` block remains the canonical
anchor.

See also:

- [docs/runners.md](runners.md) — runner profiles and the `MOMENTUM.md` policy precedence chain.
- [docs/failure-reset.md](failure-reset.md) — per-iteration outcomes and runner failure codes.
- [docs/walkthrough.md](walkthrough.md) — end-to-end disposable smoke covering queued and foreground modes.

## CLI shape

```text
momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--from-source <source-item-id>] [--data-dir <path>] [--json]
```

When `--from-source <source-item-id>` is provided, the goal is linked to that
source item at init time. The link must refer to an existing source item;
linking fails with `source_item_not_found` if the item does not exist,
`goal_not_found` if the goal does not exist, `linked_to_other_goal` if the
source item is already linked to a different goal, or `link_changed` if the
link changes concurrently. The `linkedSourceItem` field on the success
envelope is `null` when `--from-source` is not provided, or a source item
summary (`{id, adapterKind, externalId, externalKey, url, title, status,
lastObservedAt}`) when the link succeeds. Linked source items are included in
each iteration `prompt.md` as a context-only `## Source context` section
containing JSON-encoded untrusted external content; Momentum extracts text
from the latest source snapshot (`description`, `body`, `summary`, or `text`)
and truncates each body before prompt rendering.

## Default queued enqueue path (Milestone 2)

Writes the Goal row with state `queued` and enqueues a single `goal_iteration`
job (state `pending`, iteration `1`) with idempotency key
`goal:<goal-id>:iteration:1`. Repo, branch, and base HEAD are not inspected at
enqueue time — that is the worker's job. Re-running with the same spec returns
the same `goalId` and `jobId`, sets `resumed: true` / `enqueueCreated: false`,
and emits exactly one `job.enqueued` event per idempotent first-iteration
enqueue. `momentum worker run` consumes that queue and executes a claimed job
once. The resolved runner profile and its source are surfaced on the JSON
envelope.

JSON envelope shape:

```json
{
  "ok": true,
  "command": "goal start",
  "mode": "queued",
  "goalId": "<uuid>",
  "goalState": "queued",
  "jobId": "<uuid>",
  "jobType": "goal_iteration",
  "jobState": "pending",
  "iteration": 1,
  "idempotencyKey": "goal:<uuid>:iteration:1",
  "title": "Example Goal",
  "repo": "/path/to/repo",
  "branch": "momentum/example-goal",
  "baseHead": null,
  "runner": "fake",
  "runnerProfile": { "kind": "fake", "name": "fake", "description": "Built-in in-process fake runner; writes a fixture file and reports a normalized result. Dispatches through the RunnerAdapter boundary.", "executes": true },
  "runnerProfileSource": "builtin_default",
  "dataDir": "/path/to/data-dir",
  "artifactDir": "/path/to/data-dir/goals/<uuid>",
  "iterationArtifactDir": "/path/to/data-dir/goals/<uuid>/iterations/1",
  "resumed": false,
  "enqueueCreated": true,
  "policy": {
    "present": false,
    "path": null,
    "policyNotes": "",
    "config": { "runner": null, "verification": null, "verificationTimeoutSec": null },
    "effective": {
      "verification": [],
      "verificationTimeoutSec": 900,
      "source": { "verification": "builtin_default", "verificationTimeoutSec": "builtin_default" }
    }
  },
  "linkedSourceItem": null,
  "nextAction": "Goal queued. Run `momentum worker run --data-dir <path>` to claim and execute one goal_iteration job."
}
```

The `policy` block reflects the `MOMENTUM.md` summary loaded from the goal's
`repo` (when set): `present` / `path` show whether the file was found,
`policyNotes` is the raw notes body surfaced into iteration prompts, `config`
echoes the optional frontmatter (`runner` / `verification` /
`verificationTimeoutSec`, each `null` when unset), and
`effective.{verification,verificationTimeoutSec,source}` records the resolved
values applied to the goal after CLI / goal frontmatter / MOMENTUM.md /
built-in precedence. When `repo` is not set, the goal-init policy summary is
omitted (the field is absent or shows `present: false` with empty effective
values).

## Init-time validation codes

Init-time validation rejects unsupported runner profiles before touching the
database or repo. The `code` field on failure envelopes is one of:

- `parse_error` — malformed goal spec or unreadable file.
- `unsupported_runner` — unknown runner name.
- `malformed_profile` — blank or non-string runner value.
- `source_item_not_found` — `--from-source` references an unknown source item.
- `goal_not_found` — the goal cannot be located when resolving a link.
- `linked_to_other_goal` — the source item is already linked to a different goal.
- `link_changed` — the source-item link changed concurrently between read and write.
- `init_failed` — data directory or database failure.

## `--foreground` (Milestone 1 inline path)

Drives a single foreground iteration through the configured executing runner
profile and Momentum-owned verification immediately, returning the iteration
outcome on the same invocation. `fake`, `trusted-shell`, and `acp` all execute
through the shared `RunnerAdapter` boundary; unknown or non-executing
profiles fail with `unsupported_runner`. The foreground envelope also includes
`runner` and `runnerProfile` / `runnerProfileSource` fields.

JSON envelope shape:

```json
{
  "ok": true,
  "command": "goal start",
  "mode": "foreground",
  "goalId": "<uuid>",
  "jobId": "<uuid>",
  "jobType": "foreground_iteration",
  "title": "Example Goal",
  "runner": "fake",
  "runnerProfile": { "kind": "fake", "name": "fake", "description": "Built-in in-process fake runner; writes a fixture file and reports a normalized result. Dispatches through the RunnerAdapter boundary.", "executes": true },
  "runnerProfileSource": "builtin_default",
  "dataDir": "/path/to/data-dir",
  "artifactDir": "/path/to/data-dir/goals/<uuid>",
  "resumed": false,
  "state": "iteration_complete",
  "goalState": "iteration_complete",
  "jobState": "succeeded",
  "iteration": {
    "ok": true,
    "iteration": 1,
    "repoPath": "/path/to/repo",
    "branch": "momentum/example-goal",
    "branchCreated": true,
    "baseHead": "<sha>",
    "postRunnerHead": "<sha>",
    "commitSha": "<sha>",
    "commitMessage": "feat: short imperative subject without trailing period",
    "runnerSuccess": true,
    "goalComplete": false,
    "promptPath": "/path/to/data-dir/goals/<uuid>/iterations/1/prompt.md",
    "runnerLogPath": "/path/to/data-dir/goals/<uuid>/iterations/1/runner.log",
    "resultJsonPath": "/path/to/data-dir/goals/<uuid>/iterations/1/result.json",
    "verificationLogPath": "/path/to/data-dir/goals/<uuid>/iterations/1/verification.log"
  },
  "policy": {
    "present": false,
    "path": null,
    "policyNotes": "",
    "config": { "runner": null, "verification": null, "verificationTimeoutSec": null },
    "effective": {
      "verification": [],
      "verificationTimeoutSec": 900,
      "source": { "verification": "builtin_default", "verificationTimeoutSec": "builtin_default" }
    }
  },
  "linkedSourceItem": null
}
```

The foreground envelope `policy` block has the same shape as the queued
envelope and reflects the `MOMENTUM.md` summary loaded from the goal's `repo`.
The `linkedSourceItem` field is `null` when `--from-source` is not provided,
or a source item summary when the link succeeds.

## Resume behavior

Re-running `goal start` with the same goal spec against the same data
directory resumes the existing goal instead of creating duplicate state in
either mode. Text output begins with `Goal resumed`; JSON output sets
`resumed: true`.
