# Workflow commands

Operator-facing CLI envelopes for the `workflow import`, `workflow status`, `workflow handoff`, `workflow run list`, `workflow run approve`, `workflow run update-step`, `workflow run clear-recovery`, and `workflow run monitor` commands.

- `workflow import` reads local `.agent-workflows/<run-id>/` directories and persists normalized rows into the `workflow_runs`, `workflow_steps`, and `workflow_approvals` tables.
- `workflow status` is a read-only surface that lists workflow runs (with state / filter selectors) or returns the full detail of a single run.
- `workflow handoff` is a read-only surface that emits a machine-readable next-action envelope for one run.
- `workflow run list` is a read-only filterable query surface over the durable `workflow_runs` table, with additional filter dimensions not available in `workflow status` list mode.
- `workflow run approve` records durable explicit approvals for workflow boundaries and persists operator-visible metadata (actor, phrase, artifact provenance) into `workflow_approvals`.
- `workflow run update-step` drives operator-initiated step transitions (`approved` / `succeeded` / `skipped` / `failed` / `blocked` / `canceled`) through the existing state machine, persisting an audit record with operator reason and optional evidence or ledger pointers.
- `workflow run clear-recovery` explicitly clears a run's durable manual-recovery flag after the blocking condition is resolved.
- `workflow run monitor` is a read-only machine envelope that emits one stable JSON shape per run — derived from durable rows and the monitor reducer — so a monitor runner can decide whether to report, wait, or ask an operator to recover without parsing prose or scraping artifacts.

`workflow status`, `workflow handoff`, `workflow run list`, and `workflow run monitor` are read-only: they never write SQLite or files.

See also:

- [docs/data-directory.md](data-directory.md) — the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` table schemas.
- [docs/evidence-commands.md](evidence-commands.md) — `evidence ingest` and `evidence list` envelopes for the `evidence_records` table.

## `workflow import`

```text
momentum workflow import --path <run-dir> [--data-dir <path>] [--json]
```

Reads the `.agent-workflows/<run-id>/` directory at `<run-dir>` and normalizes the `plan.json`, `ledger.jsonl`, `approval-*.json`, and advisory `monitor.json` artifacts into durable `workflow_runs`, `workflow_steps`, and `workflow_approvals` rows.

`--path <run-dir>` is required. The directory basename should match the `cwfp-` / `cwfb-` / `overnight-` run ID convention; alternatively, `plan.json` may supply `runId` when it is a safe path segment. An unsafe `plan.json.runId` emits `evidence_format_invalid` with reason `plan_run_id_invalid` and import falls back to the directory basename.

### Processing rules

- **Idempotent re-import**: running `workflow import` on the same directory twice produces no duplicate rows. `created_at` is preserved on upsert; `updated_at` is bumped.
- **Terminal ledger wins**: `monitor.json` is advisory. Step and run state are derived from `ledger.jsonl` and `plan.json`; a stale monitor does not override completed ledger evidence. Its advisory snapshot is persisted on `workflow_runs` (`monitor_last_seen_state`, `monitor_terminal`, `monitor_step`, `monitor_last_seen_digest`, `monitor_last_emitted_digest`) so status / handoff / monitor drift views can compare durable substrate state against the last imported monitor tick.
- **Lost managed-task markers**: `managed-*.pid`, `managed-*.log`, and `locks/` sibling entries are ignored without diagnostics. They do not force a failed step state.
- **Unknown siblings**: unrecognized files produce `evidence_format_unknown` diagnostics but do not drop the valid records around them. The generated `recovery.md` artifact is a known sibling and is ignored by import.
- **Malformed artifacts**: invalid `plan.json`, `ledger.jsonl` lines, or `approval-*.json` files produce `evidence_format_invalid` diagnostics. Valid siblings are still imported.
- **Durable approvals merge forward**: existing database approvals, the current `approval_boundary`, and imported `approval-*.json` artifacts are merged. The highest boundary is preserved; same-rank boundaries prefer the newer recorded approval. Stale same-boundary artifacts do not overwrite newer durable approval rows. On fresh imports and re-imports, pending steps covered by any preserved approval are persisted as `approved`, and a non-terminal pending run can be persisted as `approved`.
- **Manual-recovery auto-set**: after persisting the rows, import re-derives the run's monitor view. When it classifies a blocking recovery condition (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`), import sets the durable `needs_manual_recovery` flag and renders `<run-dir>/recovery.md`. The flag blocks `workflow run approve` and any `workflow run update-step` transition that would leave a blocking recovery condition in place; a resolving update-step can land so the operator can then clear the flag with `workflow run clear-recovery`. The auto-set only ever sets the flag: re-importing a run whose blocking condition is now resolved leaves any existing flag in place, so clearing stays explicit and operator-driven.

### JSON envelope (success)

```json
{
  "ok": true,
  "command": "workflow import",
  "dataDir": "/path/to/data",
  "path": "/path/to/cwfp-abc123",
  "runId": "cwfp-abc123",
  "source": "agent-workflow",
  "state": "succeeded",
  "inserted": true,
  "approvalBoundary": "through-merge-cleanup",
  "counts": {
    "steps": 5,
    "approvals": 1,
    "diagnostics": 0
  },
  "diagnostics": [],
  "monitor": null,
  "needsManualRecovery": false,
  "recovery": null
}
```

`inserted` is `true` on first import and `false` on re-import (upsert). `counts.approvals` counts only `approval-*.json` artifacts present in the current import; preserved durable approvals are reflected in `state` and `approvalBoundary` but do not increase that count. `monitor` carries the advisory monitor snapshot (always `advisory: true`) or `null` when no `monitor.json` is present.

`needsManualRecovery` mirrors the run's durable manual-recovery flag after the import (matching the same field on `workflow status` / `workflow handoff` / `workflow run list`). `recovery` describes the blocking condition this import freshly flagged, or `null` when this import did not set the flag:

```json
{
  "needsManualRecovery": true,
  "recovery": {
    "code": "failed_required_step",
    "stepId": "implementation",
    "reason": "A required step finalized in failed state. ...",
    "artifactPath": "/path/to/cwfp-abc123/recovery.md",
    "artifactWriteError": null
  }
}
```

If the durable flag is set but rendering `recovery.md` fails, import still
returns a structured success envelope with `needsManualRecovery: true`,
`recovery.artifactPath: null`, and `recovery.artifactWriteError` set to
`{ "code": "recovery_artifact_write_failed", "message": "<render error>" }`.

A run that was already flagged on a prior import but whose blocking condition is now resolved reports `needsManualRecovery: true` with `recovery: null` — the durable flag persists until an operator clears it explicitly.

#### Diagnostic entries

Each `diagnostics` entry has the shape:

```json
{
  "code": "evidence_format_unknown",
  "path": "/path/to/cwfp-abc123/notes.txt",
  "reason": "unrecognized_filename",
  "detail": "optional human-readable detail"
}
```

| Field | Description |
|-------|-------------|
| `code` | `evidence_format_unknown` (sibling Momentum does not recognize) or `evidence_format_invalid` (artifact present but malformed). |
| `path` | Absolute path of the offending entry. |
| `reason` | Stable machine-readable reason (see below). |
| `detail` | Optional free-text detail (e.g., the parse error message). Absent when not applicable. |

`evidence_format_unknown` reasons: `unsupported_subdirectory`, `unsupported_entry_kind`, `unrecognized_filename`.

`evidence_format_invalid` reasons: `directory_unreadable`, `plan_not_object`, `plan_run_id_invalid`, `ledger_unreadable`, `ledger_line_not_json`, `ledger_line_not_object`, `ledger_line_missing_required_fields`, `ledger_run_id_mismatch`, `unknown_step_or_status`, `ledger_line_invalid_timestamp`, `monitor_not_object`, `file_unreadable`, `file_not_json`, `approval_not_object`, `approval_run_id_mismatch`, `approval_missing_boundary`, `approval_invalid_boundary`, `approval_invalid_timestamp`.

### JSON envelope (failure)

```json
{
  "ok": false,
  "command": "workflow import",
  "code": "import_path_unreadable",
  "message": "Cannot read import path: ...",
  "dataDir": "/path/to/data",
  "path": "/path/to/cwfp-abc123",
  "diagnostics": []
}
```

`dataDir` and `path` are emitted whenever they are known at the point of failure. `path_required` is the only code that omits both (no `--path` was supplied and data-dir resolution has not been attempted). `data_dir_failed` omits `dataDir` (resolution itself failed) but includes `path`. All other codes include both.

Error codes:

| Code | Meaning |
|------|---------|
| `path_required` | `--path` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `import_path_unreadable` | `--path` does not exist or is not readable. |
| `import_path_not_directory` | `--path` is not a directory. |
| `import_run_id_missing` | No `runId` in `plan.json` and the directory basename does not match the `cwfp-` / `cwfb-` / `overnight-` pattern. |

### Text output (success)

```text
Workflow import: /path/to/cwfp-abc123
Run: cwfp-abc123 (agent-workflow)
State: succeeded
Inserted: yes
Steps: 5
Approvals: 1
Diagnostics: 0
Manual recovery: not required
Data dir: /path/to/data
```

The `Manual recovery` line reads `required (<code>) -> <recovery.md path>` when this import auto-set the flag, `required (<code>); recovery.md write failed: <message>` when the durable flag was set but rendering the artifact failed, `flagged (clear explicitly once resolved)` when the run has an existing durable flag but this import did not classify a blocking recovery condition, and `not required` otherwise.

### Text output (failure)

```text
Cannot read import path: ...
```

Exit code 1 is returned on failure; exit code 0 on success.

## `workflow run approve`

```text
momentum workflow run approve <run-id> --approval-boundary <boundary> --phrase <text> [--actor <name>] [--artifact-path <path>] [--artifact-digest <sha256>] [--data-dir <path>] [--json]
```

Records an explicit durable approval for one workflow run boundary and emits a stable JSON/text envelope.

Validation rules:

- `--approval-boundary` must be one of: `implementation`, `through-implementation`, `no-mistakes`, `through-no-mistakes`, `merge-cleanup`, `through-merge-cleanup`, `full`, `plan-only`, `overnight-safe`, `through-postflight`, `through-merge-gates`, `final-cleanup`, `full-batch`.
- `--phrase` must be non-empty, affirmative, include `approve`, and include the requested boundary.
- `--artifact-path`, when supplied, must be readable.
- If `--artifact-digest` is supplied with `--artifact-path`, it must match the SHA-256 digest of that file (or the command refuses).

If `--artifact-path` is omitted, Momentum stores the synthetic provenance URI `workflow-run-approve://<run-id>/<boundary>` in `artifactPath` and synthesizes a deterministic provenance digest from `approve:<run-id>:<boundary>:<phrase>`. A supplied `--artifact-digest` without `--artifact-path` must match that synthesized digest.

On success, the command inserts a `workflow_approvals` row, updates `workflow_runs.approval_boundary` to the new boundary unless the stored boundary has a strictly higher rank (same-rank approvals replace the stored boundary), promotes a pending run to `approved`, and marks pending steps covered by the boundary as `approved`.

Boundary coverage:

| Boundary | Pending steps approved |
|----------|------------------------|
| `plan-only` | none |
| `implementation`, `through-implementation` | `preflight`, `implementation` |
| `through-postflight` | `preflight`, `implementation`, `postflight` |
| `no-mistakes`, `through-no-mistakes`, `overnight-safe`, `through-merge-gates` | `preflight`, `implementation`, `postflight`, `no-mistakes` |
| `merge-cleanup`, `through-merge-cleanup` | `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup` |
| `full`, `final-cleanup`, `full-batch` | `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh` |

The command is idempotent by `(run-id, boundary)`; approving the same pair twice returns a stable duplicate refusal instead of creating duplicate rows.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run approve",
  "dataDir": "/path/to/data",
  "runId": "cwfp-abc123",
  "boundary": "through-implementation",
  "phrase": "approve pipeline cwfp-abc123 through implementation",
  "actor": "calvinnwq",
  "artifactPath": "/path/to/approval-implementation.json",
  "artifactDigest": "f2f...a4",
  "recordedAt": 1730000000000
}
```

When `--artifact-path` is omitted, `artifactPath` is `workflow-run-approve://<run-id>/<boundary>` and `artifactDigest` is the synthetic digest described above. When `--actor` is omitted, JSON still emits `"actor": null`.

### Text output

Text output prints a stable human-readable confirmation and omits JSON-only fields such as `artifactDigest` and `recordedAt`:

```text
Workflow run approval recorded for cwfp-abc123
Boundary: through-implementation
Phrase: approve pipeline cwfp-abc123 through implementation
Actor: calvinnwq
Artifact: /path/to/approval-implementation.json
Data dir: /path/to/data
```

When `--actor` is omitted, the `Actor:` line prints `(unset)`. When `--artifact-path` is omitted, the `Artifact:` line prints `(inline/implicit)`.

### Error codes

After the run, boundary, and phrase resolve, duplicate approvals short-circuit mutable validations: an existing `(run-id, boundary)` row returns `duplicate_approval` before terminal-state, manual-recovery, or artifact-digest checks.

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `manual_recovery_required` | The run is blocked by its durable manual-recovery flag and must be cleared before approval. |
| `invalid_state` | The run is already terminal and cannot accept new approvals. |
| `invalid_boundary` | Missing or unsupported boundary value, or phrase is casual, missing, negated, non-affirmative, or insufficient for the requested boundary. |
| `approval_digest_mismatch` | `--artifact-path` is unreadable/missing, or `--artifact-digest` was supplied and does not match the resolved digest. |
| `duplicate_approval` | A durable approval already exists for the same run and boundary. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run update-step`

```text
momentum workflow run update-step <run-id> --step <step-id> --state <approved|succeeded|skipped|failed|blocked|canceled> --reason <text> [--actor <name>] [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]
```

Drives an operator-initiated step transition through the existing state machine and persists a durable audit record.

Required arguments:

- `<run-id>` — the run to update.
- `--step <step-id>` — the step to transition (e.g. `preflight`, `implementation`, `postflight`, `no-mistakes`, `merge-cleanup`, `linear-refresh`).
- `--state <target>` — one of `succeeded`, `skipped`, `failed`, `blocked`.
- `--reason <text>` — operator-supplied rationale, stored in the durable audit record.

Optional arguments:

- `--actor <name>` — operator identity; stored alongside the audit record; defaults to null when omitted.
- `--evidence-pointer <ref>` — free-form reference to an evidence artifact (e.g. `.agent-workflows/<run-id>/ledger.jsonl#offset=42`).
- `--ledger-pointer <ref>` — free-form reference to a ledger entry.

Behaviour:

- Illegal transitions (e.g. finalizing a `pending` step, transitioning from a terminal state to a different terminal state) refuse with `invalid_transition` and write no durable state.
- A byte-equal repeat of an existing finalize (same `--state`, `--reason`, `--actor`, `--evidence-pointer`, and `--ledger-pointer`) returns successfully with `idempotent: true` and does not update the stored audit record.
- A repeat with a different reason, actor, or pointers refuses with `invalid_transition`; the existing audit record is preserved.
- After a successful step transition the run state is re-derived from the full step chain; if the derived state differs from the stored one, `workflow_runs.state` is updated in the same transaction.
- The command is local-only: it never spawns an executor, schedules cron, or issues an external write.
- If the run has `needs_manual_recovery` set, transitions that would leave a blocking recovery condition in place refuse with `manual_recovery_required`; transitions that resolve the blocking condition can land so the flag can be cleared explicitly afterward.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run update-step",
  "dataDir": "/path/to/data",
  "runId": "cwfp-abc123",
  "stepId": "implementation",
  "state": "succeeded",
  "previousState": "running",
  "runState": "succeeded",
  "reason": "managed child finished but durable terminal evidence never landed",
  "actor": "calvinnwq",
  "evidencePointer": ".agent-workflows/cwfp-abc123/ledger.jsonl#offset=42",
  "ledgerPointer": null,
  "idempotent": false
}
```

`actor`, `evidencePointer`, and `ledgerPointer` are always present in JSON output (null when not supplied).

### Text output

```text
Workflow step updated for cwfp-abc123
Step: implementation
State: running -> succeeded
Run state: succeeded
Reason: managed child finished but durable terminal evidence never landed
Actor: calvinnwq
Data dir: /path/to/data
```

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `manual_recovery_required` | The run is blocked by its durable manual-recovery flag and the requested transition would leave a blocking recovery condition in place. |
| `step_not_found` | `--step` was not supplied or does not match any step row for this run. |
| `invalid_state` | `--state` is not one of the allowed target states. |
| `invalid_transition` | The requested transition is not legal from the current step state, `--reason` was omitted, or an existing finalize would be overwritten with a different audit context. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow run clear-recovery`

```text
momentum workflow run clear-recovery <run-id> [--data-dir <path>] [--json]
```

Explicit, auditable clear for a run's durable manual-recovery flag. The flag blocks `workflow run approve` and non-resolving `workflow run update-step` transitions until an operator clears it here.

Required arguments:

- `<run-id>` — the flagged run to clear.

Behaviour:

- Re-derives the monitor view from the durable substrate inside a single immediate transaction and clears the flag only when no blocking recovery condition remains. The check and the clear are atomic: the condition that is checked is the condition that is cleared.
- Refuses with `recovery_clear_refused` while a blocking recovery classification (`manual_recovery_lease`, `ghost_active_no_lease`, `stale_running_step`, or `failed_required_step`) still applies; the refusal carries the `recoveryCode` and, when known, the `blockingStepId`, and the flag stays set.
- Refuses with `not_flagged` when the run is not currently flagged, so a stale clear cannot mutate anything.
- Never auto-clears from elapsed time alone, never repairs the underlying run, and never issues an external write. The `recovery.md` artifact is intentionally left on disk as durable audit; remove it after capturing the context elsewhere.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run clear-recovery",
  "runId": "cwfp-abc123",
  "dataDir": "/path/to/data",
  "previousReason": "ghost active step recovered by operator",
  "previousMarkedAt": 1730000000000,
  "clearedAt": 1730000600000
}
```

### Text output

```text
Manual recovery cleared for run: cwfp-abc123
Previous reason: ghost active step recovered by operator
Previous marked at: 1730000000000
Cleared at: 1730000600000
Data dir: /path/to/data
```

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `run_id_required` | `<run-id>` was not supplied. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |
| `not_flagged` | The run is not currently flagged for manual recovery; nothing to clear. |
| `recovery_clear_refused` | A blocking recovery condition still applies; resolve it before clearing. Carries `recoveryCode` and optional `blockingStepId`. |

Exit code 0 on success, 1 on structured refusal, 2 on usage error.

## `workflow status`

```text
momentum workflow status [<run-id>] [--state <state>] [--filter <active|blocked|completed|imported>] [--limit <n>] [--data-dir <path>] [--json]
```

Two modes share one envelope shape:

- **List mode** (no `<run-id>`): returns workflow runs filtered by state or by a named grouping. Ordered by `updated_at DESC`.
- **Detail mode** (with `<run-id>`): returns the full detail for one run — steps, approvals, leases, monitor reducer view, and evidence linkage.

### Selectors (list mode)

- `--state <state>` filters by literal `workflow_runs.state` value. Allowed: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- `--filter <key>` groups runs into operator-friendly buckets:
  - `active` → `pending`, `approved`, `running`
  - `blocked` → `blocked`
  - `completed` → `succeeded`, `failed`, `canceled`
  - `imported` → only runs whose `source == "agent-workflow"`
- `--limit <n>` caps the number of returned runs (after filtering).

State and filter compose: passing both returns runs whose literal state matches `--state` and falls inside the `--filter` bucket. An empty intersection (e.g., `--state succeeded --filter active`) returns zero runs. The `imported` bucket only constrains `source`, so it composes with `--state` without narrowing states further.

### JSON envelope — list mode

```json
{
  "ok": true,
  "command": "workflow status",
  "dataDir": "/path/to/data",
  "state": null,
  "filter": "active",
  "count": 1,
  "runs": [
    {
      "run": {
        "runId": "cwfp-abc123",
        "state": "running",
        "source": "agent-workflow",
        "approvalBoundary": "through-merge-cleanup",
        "objective": "land workflow status CLI",
        "issueScope": {},
        "route": {},
        "needsManualRecovery": false,
        "startedAt": 1730000000000,
        "finishedAt": null,
        "createdAt": 1730000000000,
        "updatedAt": 1730000600000
      },
      "counts": {
        "steps": 5,
        "stepsByState": {
          "pending": 1,
          "approved": 0,
          "running": 1,
          "succeeded": 3,
          "failed": 0,
          "skipped": 0,
          "blocked": 0,
          "canceled": 0
        },
        "approvals": 1,
        "leases": 1
      },
      "monitor": { "...": "see Monitor envelope below" }
    }
  ]
}
```

### JSON envelope — detail mode

The detail envelope flattens the per-run view at the top level (`run`, `steps`, `approvals`, `leases`, `monitor`, `evidence`):

```json
{
  "ok": true,
  "command": "workflow status",
  "dataDir": "/path/to/data",
  "run": { "runId": "cwfp-abc123", "state": "running", "...": "..." },
  "steps": [
    {
      "runId": "cwfp-abc123",
      "stepId": "implementation",
      "kind": "implementation",
      "state": "running",
      "order": 1,
      "required": true,
      "ledgerOffset": 2,
      "resultDigest": null,
      "errorCode": null,
      "errorMessage": null,
      "startedAt": 1730000100000,
      "finishedAt": null,
      "createdAt": 1730000000000,
      "updatedAt": 1730000100000
    }
  ],
  "approvals": [
    {
      "runId": "cwfp-abc123",
      "boundary": "through-merge-cleanup",
      "actor": "calvinnwq",
      "phrase": "approve",
      "artifactPath": "/path/to/cwfp-abc123/approval-merge.json",
      "artifactDigest": "...",
      "recordedAt": 1730000050000,
      "dischargedAt": null,
      "createdAt": 1730000050000,
      "updatedAt": 1730000050000
    }
  ],
  "leases": [
    {
      "runId": "cwfp-abc123",
      "leaseKind": "managed-step",
      "holder": "openclaw-coding-workflow-pipeline",
      "acquiredAt": 1730000100000,
      "expiresAt": 1730000400000,
      "heartbeatAt": 1730000200000,
      "releasedAt": null,
      "stalePolicy": "auto-release",
      "createdAt": 1730000100000,
      "updatedAt": 1730000200000
    }
  ],
  "monitor": {
    "runId": "cwfp-abc123",
    "runState": "running",
    "terminal": false,
    "blocked": false,
    "activeStep": {
      "stepId": "implementation",
      "kind": "implementation",
      "state": "running",
      "order": 1,
      "required": true
    },
    "leases": [
      {
        "leaseKind": "managed-step",
        "holder": "openclaw-coding-workflow-pipeline",
        "classification": "fresh",
        "expiresAt": 1730000400000,
        "heartbeatAt": 1730000200000,
        "releasedAt": null
      }
    ],
    "lastCheckpoint": {
      "stepId": "implementation",
      "at": 1730000100000,
      "source": "ledger",
      "digest": null
    },
    "monitorDrift": null,
    "nextAction": {
      "code": "resume_running",
      "stepId": "implementation",
      "leaseKind": "managed-step",
      "detail": "Step is running with fresh lease / checkpoint evidence. Allow it to continue."
    },
    "needsRecoveryArtifact": false,
    "recovery": null
  },
  "evidence": []
}
```

### State / next-action vocabulary

`run.state` and `steps[].state` use the canonical workflow vocabulary:

- Run states: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- Step states: `pending`, `approved`, `running`, `succeeded`, `failed`, `skipped`, `blocked`, `canceled`.

`monitor.nextAction.code` is one of:

- `no_action` — terminal run (succeeded / canceled); no follow-up needed.
- `advance_to_step` — an approved step is ready to dispatch.
- `await_approval` — a pending step needs approval before it can run.
- `resume_running` — a running step has fresh evidence; let it continue.
- `investigate_stale` — a running step is stale (no fresh lease, no recent checkpoint) or an orphan lease is holding a finalized run open.
- `clear_recovery` — the run is blocked (manual-recovery-required lease or blocked step); clear the recovery once the cause is resolved.
- `rerun_failed_step` — a required step failed; decide whether to retry or mark for manual recovery.

`monitor.recovery.code`, when present, is one of: `stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`.

Lease classifications surfaced under `monitor.leases[].classification`: `released`, `fresh`, `stale-auto-release`, `stale-manual-recovery-required`.

### Evidence linkage

`detail.evidence` returns `evidence_records` rows linked to the run. Rows ingested via `evidence ingest` against a `.agent-workflows/<runId>/` directory carry a durable typed `runId` / `stepId` on each record; those are the primary join. For rows ingested before typed linkage existed (null `run_id`), the query falls back to `artifact_path` prefix matching under the run's source artifact directory so legacy evidence continues to surface.

Each evidence item exposes: `evidenceRecordId`, `source`, `type`, `artifactPath`, `occurredAt`, `summary`, `runId`, and `stepId`.

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `invalid_state` | `--state` is not one of the canonical workflow run states. |
| `invalid_filter` | `--filter` is not one of `active`, `blocked`, `completed`, `imported`. |
| `invalid_limit` | `--limit` is not a non-negative integer. (Note: the flag parser validates `--limit` before the command runs, so invalid limits produce a usage error / exit code 2 rather than this structured refusal.) |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

### Text output (list mode)

```text
Workflow runs: 1
State: (any)
Filter: active
Data dir: /path/to/data
- cwfp-abc123 [running] steps=5 approvals=1 leases=1 next=resume_running
```

### Text output (detail mode)

```text
Workflow run: cwfp-abc123
State: running
Source: agent-workflow
Objective: land workflow status CLI
Repo: /path/to/repo
Approval boundary: through-merge-cleanup
Data dir: /path/to/data

Steps: 5
- preflight [succeeded] kind=preflight order=0 required=yes
- implementation [running] kind=implementation order=1 required=yes
...

Monitor
- Run state: running
- Terminal: no
- Blocked: no
- Active step: implementation (running)
- Last checkpoint: implementation at 1730000100000 (source=ledger)
- Next action: resume_running - Step is running with fresh lease / checkpoint evidence. Allow it to continue.

Evidence: 1
- evidence_record_impl [agent-workflow/implementation_complete] implementation finished step=implementation
```

Evidence rows include a trailing `step=<stepId>` annotation when the record carries typed step linkage.

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow handoff`

```text
momentum workflow handoff <run-id> [--data-dir <path>] [--json]
```

Emits a machine-readable next-action envelope for one workflow run. Wraps the same detail loader as `workflow status <run-id>`, adds `schemaVersion` and `generatedAt`, and surfaces `nextAction` at the top level (mirroring `monitor.nextAction`) so OpenClaw tooling can dispatch without re-reading the monitor block.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow handoff",
  "dataDir": "/path/to/data",
  "schemaVersion": 1,
  "generatedAt": 1730000600000,
  "run": { "...": "same shape as workflow status detail" },
  "steps": [ "..." ],
  "approvals": [ "..." ],
  "leases": [ "..." ],
  "monitor": { "...": "same shape as workflow status detail" },
  "evidence": [ "..." ],
  "nextAction": {
    "code": "resume_running",
    "stepId": "implementation",
    "leaseKind": "managed-step",
    "detail": "Step is running with fresh lease / checkpoint evidence. Allow it to continue."
  }
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

### Text output

```text
Workflow handoff: cwfp-abc123
Schema version: 1
Generated at (epoch ms): 1730000600000

Workflow run: cwfp-abc123
... (same shape as workflow status detail)
```

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run list`

```text
momentum workflow run list [--state <state>] [--filter <active|blocked|completed|imported>] [--approval-boundary <boundary>] [--repo <path>] [--issue-scope <identifier>] [--updated-since <ms>] [--updated-until <ms>] [--limit <n>] [--data-dir <path>] [--json]
```

Read-only filterable query over the durable `workflow_runs` table. Returns run summaries ordered by `updated_at DESC`. The identifiers in each summary row are sufficient to pass directly into `workflow status <run-id>` or `workflow handoff <run-id>` without re-derivation.

All filters are optional and compose: passing multiple filters narrows the result set by AND. An empty result set (no matching runs) is a successful response, not a refusal.

### Selectors

- `--state <state>` filters by literal `workflow_runs.state`. Allowed values: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- `--filter <key>` groups runs into operator-friendly buckets (same buckets as `workflow status`):
  - `active` → `pending`, `approved`, `running`
  - `blocked` → `blocked`
  - `completed` → `succeeded`, `failed`, `canceled`
  - `imported` → runs whose `source == "agent-workflow"` (composes with `--state` without narrowing states further)
- `--approval-boundary <boundary>` filters by the exact `approval_boundary` value on the run row.
- `--repo <path>` filters by exact `repo_path` match.
- `--issue-scope <identifier>` filters by substring match against `issue_scope_json` (LIKE, case-insensitive for ASCII letters per SQLite default).
- `--updated-since <ms>` filters to runs with `updated_at >= <ms>` (epoch milliseconds).
- `--updated-until <ms>` filters to runs with `updated_at <= <ms>` (epoch milliseconds).
- `--limit <n>` caps the number of returned runs (after filtering).

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run list",
  "dataDir": "/path/to/data",
  "state": null,
  "filter": "active",
  "approvalBoundary": null,
  "repoPath": null,
  "issueScope": null,
  "updatedSince": null,
  "updatedUntil": null,
  "count": 1,
  "runs": [
    {
      "run": {
        "runId": "cwfp-abc123",
        "state": "running",
        "source": "agent-workflow",
        "approvalBoundary": "through-merge-cleanup",
        "repoPath": "/path/to/repo",
        "objective": "land workflow status CLI",
        "issueScope": {},
        "needsManualRecovery": false,
        "startedAt": 1730000000000,
        "finishedAt": null,
        "createdAt": 1730000000000,
        "updatedAt": 1730000600000
      },
      "counts": {
        "steps": 5,
        "stepsByState": {
          "pending": 1,
          "approved": 0,
          "running": 1,
          "succeeded": 3,
          "failed": 0,
          "skipped": 0,
          "blocked": 0,
          "canceled": 0
        },
        "approvals": 1,
        "leases": 1
      },
      "monitor": {
        "runState": "running",
        "terminal": false,
        "blocked": false,
        "nextAction": { "code": "resume_running" }
      }
    }
  ]
}
```

Top-level filter fields (`state`, `filter`, `approvalBoundary`, `repoPath`, `issueScope`, `updatedSince`, `updatedUntil`) echo the active filters, or `null` when not supplied. `count` is the number of matched runs. Each entry in `runs` uses the same `{ run, counts, monitor }` shape as `workflow status` list mode.

### Error codes

| Code | Meaning |
|------|---------|
| `data_dir_failed` | Data directory resolution failed. |
| `invalid_state` | `--state` is not one of the canonical workflow run states. |
| `invalid_filter` | `--filter` is not one of `active`, `blocked`, `completed`, `imported`. |
| `invalid_limit` | `--limit` is not a non-negative integer. (Note: the flag parser validates `--limit` before the command runs, so invalid limits produce a usage error / exit code 2 rather than this structured refusal.) |

### Text output

```text
Workflow runs: 1
State: (any)
Filter: active
Approval boundary: (any)
Repo: (any)
Issue scope: (any)
Updated since: (any)
Updated until: (any)
Data dir: /path/to/data
- cwfp-abc123 [running] repo=/path/to/repo steps=5 approvals=1 leases=1 next=resume_running
```

Exit code 0 on success, 1 on failure, 2 on usage error.

## `workflow run monitor`

```text
momentum workflow run monitor <run-id> [--data-dir <path>] [--json]
```

Read-only machine envelope for a monitor runner. Wraps the same durable detail loader as `workflow status <run-id>`, runs the monitor reducer, and adds a `disposition` decision view so a caller can act on one stable JSON shape per tick instead of parsing prose or scraping `.agent-workflows/<run-id>/`. It never writes SQLite or files, never schedules cron, and never delivers notifications.

Required arguments:

- `<run-id>` — the run to inspect.

### Disposition and report reason

`disposition` is the single field a monitor runner branches on:

- `wait` — nothing actionable; the run is progressing (`in_progress`) or has no actionable steps yet (`idle`). `reportable` is `false`.
- `report` — surface the run to the operator, but no recovery action is needed: a terminal outcome (`terminal_succeeded` / `terminal_canceled`), a step `awaiting_approval`, or `monitor_drift` (the run keeps progressing while the advisory snapshot is stale). `reportable` is `true`.
- `recover` — an operator must intervene: the run is `blocked`, carries a durable manual-recovery flag, or the monitor reducer classified a hard recovery condition. `reportReason` is `recovery_required` and `reportable` is `true`.

`reportReason` is one of `terminal_succeeded`, `terminal_canceled`, `recovery_required`, `monitor_drift`, `awaiting_approval`, `in_progress`, `idle`. `reportable` is always `disposition != "wait"`.

The hard recovery classifications (`recovery.code`) are the same taxonomy as `workflow status`: `stale_running_step`, `ghost_active_no_lease`, `manual_recovery_lease`, `monitor_drift_stale`, `failed_required_step`. A failed required step and a blocked run both resolve to `disposition: "recover"`; `monitor_drift_stale` on an otherwise-progressing run resolves to `disposition: "report"`.

### JSON envelope

```json
{
  "ok": true,
  "command": "workflow run monitor",
  "dataDir": "/path/to/data",
  "schemaVersion": 1,
  "generatedAt": 1730000600000,
  "runId": "cwfp-abc123",
  "runState": "running",
  "stepState": "running",
  "terminal": false,
  "blocked": false,
  "needsManualRecovery": false,
  "disposition": "wait",
  "reportable": false,
  "reportReason": "in_progress",
  "activeStep": {
    "stepId": "implementation",
    "kind": "implementation",
    "state": "running",
    "order": 1,
    "required": true
  },
  "leases": [{ "...": "same shape as workflow status monitor.leases" }],
  "lastCheckpoint": { "...": "same shape as workflow status monitor.lastCheckpoint" },
  "monitorDrift": null,
  "nextAction": {
    "code": "resume_running",
    "stepId": "implementation",
    "leaseKind": "managed-step",
    "detail": "Step is running with fresh lease / checkpoint evidence. Allow it to continue."
  },
  "recovery": null,
  "evidence": [{ "...": "same typed evidence pointers as workflow status detail" }],
  "counts": {
    "steps": 5,
    "stepsByState": { "...": "per-state step counts" },
    "approvals": 1,
    "leases": 1
  }
}
```

`schemaVersion` is `1`. `nextAction`, `recovery`, `monitorDrift`, `leases`, `lastCheckpoint`, and `evidence` reuse the same field shapes as `workflow status`. `stepState` is the active step's state (or `null` when there is no active step).

### Error codes

| Code | Meaning |
|------|---------|
| `run_id_required` | `<run-id>` was not supplied. |
| `data_dir_failed` | Data directory resolution failed. |
| `run_not_found` | `<run-id>` does not exist in `workflow_runs`. |

### Text output

```text
Workflow run monitor: cwfp-abc123
Schema version: 1
Run state: running
Step state: running
Terminal: false
Blocked: false
Needs manual recovery: false
Disposition: wait
Reportable: false
Report reason: in_progress
Next action: resume_running
Active step: implementation [running]
Steps: 5 approvals=1 leases=1
Data dir: /path/to/data
```

A `Recovery: <code>` line is added when a recovery classification is present.

Exit code 0 on success, 1 on failure, 2 on usage error.
