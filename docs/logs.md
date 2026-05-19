# `logs`

This page is the canonical reference for the `logs` command — Momentum's
read-only iteration-artifact inspector. It reads the on-disk artifact
directory for a goal's iteration plus SQLite linked-source and evidence
summaries, and emits a stable JSON envelope (or human-readable text) that
exposes `runner.log`, `verification.log`, and the runner result JSON
artifact.

See also:

- [`docs/status.md`](status.md) for the read-only goal-state inspector that
  reads adjacent SQLite state without surfacing per-iteration log content.
- [`docs/handoff.md`](handoff.md) for the operator handoff renderer that
  composes the same per-iteration outcome into durable artifacts.
- [`docs/worker-run.md`](worker-run.md) for the worker pipeline that writes
  the `runner.log`, `verification.log`, and result JSON artifacts that
  `logs` reads.
- [`docs/runners.md`](runners.md) for the `RunnerResult` schema that the
  result JSON artifact is validated against.
- [`docs/failure-reset.md`](failure-reset.md) for the per-iteration
  transaction model and the failure-code taxonomy surfaced in
  `verification.log` and the result envelope.

## CLI shape

```text
momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]
```

`<goal-id>` is required. Without `--iteration`, `logs` selects the
highest-numbered iteration directory under
`<data-dir>/goals/<goal-id>/iterations/` (or the goal row's stored
`current_iteration` value when present), so a freshly-initialized goal
returns iteration `1` with empty logs and a scaffolded empty `result.json`.
With `--iteration <n>`, `logs` reads that iteration's artifact directory
and exits non-zero with `code: "iteration_not_found"` when the directory
does not exist. `--iteration` must be a positive integer; non-positive or
non-integer values fail with `code: "usage_error"`. `--data-dir <path>`
selects a non-default Momentum home (otherwise `MOMENTUM_HOME` env /
`~/.momentum` fallback). `--json` switches between the human-readable
text output and the machine-readable JSON envelope documented below.

The command only reads local artifacts plus SQLite linked-source and
evidence summaries; it does not consult live worker state. This makes
`logs` safe to run against a goal that is currently being processed by a
worker — the output reflects what is durably persisted on disk, not the
in-flight state of an executing iteration.

## JSON envelope

Top-level keys exposed when `--json` is passed:

- `goalId` — the goal identifier passed on the CLI.
- `iteration` — the resolved iteration number (the highest-numbered or
  the explicit `--iteration <n>` value).
- `availableIterations` — array of iteration numbers (integers) present
  under `goals/<goal-id>/iterations/`, sorted ascending.
- `runnerLog` — per-file block for `runner.log` (see "Per-file block"
  below).
- `verificationLog` — per-file block for `verification.log` (see
  "Per-file block").
- `resultJson` — per-file block for the runner result artifact, augmented
  with `parseError` when applicable (see "Result JSON envelope").
- `sourceItems` — linked source item summaries for the goal, sourced from
  SQLite (newest-first). Empty array when the goal has no linked source
  items.
- `latestEvidence` — present when non-empty, newest-first, up to five
  records. Each entry summarizes a row from the `evidence_records` table.

## Per-file block

Every file slot (`runnerLog`, `verificationLog`, `resultJson`) uses the
same shape:

- `path` — absolute path to the file inside the iteration artifact
  directory.
- `exists` — boolean indicating whether the file is present on disk.
- `readable` — boolean indicating whether the file is readable from the
  current process.
- `bytes` — file size in bytes (`0` when the file is empty or absent).
- `content` — the textual content of the file (empty string when absent
  or empty).
- `error` — a stable diagnostic string when the file cannot be read,
  otherwise `null`.

## Result JSON envelope

`resultJson` extends the per-file block with a `parseError` field. The
field is populated when the file exists but is malformed JSON or fails
the normalized `RunnerResult` schema. Empty content and the initialized
`{}` scaffold are treated as "not written yet" and are not a parse error,
so operators only see parse diagnostics for real malformed result
artifacts. This rule matches how iteration finalization writes the
artifact: an empty `{}` is the placeholder Momentum scaffolds at goal
init time, and a populated `RunnerResult` is written by the runner
adapter at execution time.

When the result JSON conforms to the `RunnerResult` schema, `parseError`
is `null` and the parsed content is available via the `content` field of
the per-file block. The `RunnerResult` schema details (`status`,
`failure_code`, `commit_sha`, `output_overflow`, and the failure-code
taxonomy) live in [`docs/runners.md`](runners.md).

## Failure surfaces

- `code: "iteration_not_found"` — `--iteration <n>` was provided but the
  artifact directory does not exist.
- `code: "usage_error"` — `--iteration` value is not a positive integer.

Both surfaces exit non-zero and include the offending input in the JSON
output so operators can debug the invocation.

## Text output

When `--json` is omitted, `logs` emits a human-readable summary that
mirrors the JSON envelope:

- `Source items:` and `Latest evidence:` blocks render when present.
- A `## result.json` section renders the parsed result envelope (or the
  raw content when parsing fails).
- A parse-error note is printed when `resultJson.parseError` is populated,
  so operators can see immediately that the runner artifact is
  malformed.

The text output is intended for quick operator inspection; the JSON
envelope is the canonical machine-readable shape for downstream tooling.
