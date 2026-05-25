# Workflow commands

Operator-facing CLI envelopes for the `workflow import`, `workflow status`, and `workflow handoff` commands.

- `workflow import` reads local `.agent-workflows/<run-id>/` directories and persists normalized rows into the `workflow_runs`, `workflow_steps`, and `workflow_approvals` tables.
- `workflow status` is a read-only surface that lists workflow runs (with state / filter selectors) or returns the full detail of a single run.
- `workflow handoff` is a read-only surface that emits a machine-readable next-action envelope for one run.

`workflow status` and `workflow handoff` are read-only: they never write SQLite or files.

See also:

- [docs/data-directory.md](data-directory.md) — the `workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases` table schemas.
- [docs/evidence-commands.md](evidence-commands.md) — `evidence ingest` and `evidence list` envelopes for the `evidence_records` table.

## `workflow import`

```text
momentum workflow import --path <run-dir> [--data-dir <path>] [--json]
```

Reads the `.agent-workflows/<run-id>/` directory at `<run-dir>` and normalizes the `plan.json`, `ledger.jsonl`, `approval-*.json`, and advisory `monitor.json` artifacts into durable `workflow_runs`, `workflow_steps`, and `workflow_approvals` rows.

`--path <run-dir>` is required. The directory basename should match the `cwfp-` / `cwfb-` / `overnight-` run ID convention; alternatively, `plan.json` may supply `runId`.

### Processing rules

- **Idempotent re-import**: running `workflow import` on the same directory twice produces no duplicate rows. `created_at` is preserved on upsert; `updated_at` is bumped.
- **Terminal ledger wins**: `monitor.json` is advisory. Step and run state are derived from `ledger.jsonl` and `plan.json`; a stale monitor does not override completed ledger evidence.
- **Lost managed-task markers**: `managed-*.pid`, `managed-*.log`, and `locks/` sibling entries are ignored without diagnostics. They do not force a failed step state.
- **Unknown siblings**: unrecognized files produce `evidence_format_unknown` diagnostics but do not drop the valid records around them.
- **Malformed artifacts**: invalid `plan.json`, `ledger.jsonl` lines, or `approval-*.json` files produce `evidence_format_invalid` diagnostics. Valid siblings are still imported.

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
  "monitor": null
}
```

`inserted` is `true` on first import and `false` on re-import (upsert). `monitor` carries the advisory monitor snapshot (always `advisory: true`) or `null` when no `monitor.json` is present.

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

`evidence_format_invalid` reasons: `directory_unreadable`, `plan_not_object`, `ledger_unreadable`, `ledger_line_not_json`, `ledger_line_not_object`, `ledger_line_missing_required_fields`, `ledger_run_id_mismatch`, `unknown_step_or_status`, `ledger_line_invalid_timestamp`, `monitor_not_object`, `file_unreadable`, `file_not_json`, `approval_not_object`, `approval_run_id_mismatch`, `approval_missing_boundary`, `approval_invalid_boundary`, `approval_invalid_timestamp`.

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
Data dir: /path/to/data
```

### Text output (failure)

```text
Cannot read import path: ...
```

Exit code 1 is returned on failure; exit code 0 on success.

## `workflow status`

```text
momentum workflow status [<run-id>] [--state <state>] [--filter <active|blocked|completed|imported>] [--limit <n>] [--data-dir <path>] [--json]
```

Two modes share one envelope shape:

- **List mode** (no `<run-id>`): returns workflow runs filtered by state or by a named grouping. Ordered by `updated_at DESC`.
- **Detail mode** (with `<run-id>`): returns the full detail for one run — steps, approvals, leases, monitor reducer view, and best-effort evidence linkage.

### Selectors (list mode)

- `--state <state>` filters by literal `workflow_runs.state` value. Allowed: `pending`, `approved`, `running`, `succeeded`, `failed`, `blocked`, `canceled`.
- `--filter <key>` groups runs into operator-friendly buckets:
  - `active` → `pending`, `approved`, `running`
  - `blocked` → `blocked`
  - `completed` → `succeeded`, `failed`, `canceled`
  - `imported` → only runs whose `source == "agent-workflow"`
- `--limit <n>` caps the number of returned runs (after filtering).

State and filter are independent: passing both narrows runs by literal state first, then re-applies the bucket filter (the `imported` bucket additionally filters on source).

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

`detail.evidence` is best-effort: it returns `evidence_records` rows whose `artifact_path` falls under the run's artifact directory. The durable `evidence_records.run_id` / `step_id` extension is deferred to a follow-up slice; entries here surface so OpenClaw tooling can find related evidence without an additional join.

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

Evidence: 0
```

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
