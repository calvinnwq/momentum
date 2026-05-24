# Workflow commands

Operator-facing CLI envelopes for the `workflow import` command. This command reads local `.agent-workflows/<run-id>/` directories and persists normalized rows into the `workflow_runs`, `workflow_steps`, and `workflow_approvals` tables.

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
