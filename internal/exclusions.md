# Current Exclusions Anchor

Long-form exclusion rationale moved to Obsidian during DOCS-02:
`/Workspaces/Momentum/Specs/2026-06-22-runtime-queue-and-dogfood-evidence.md`.

This anchor preserves current exclusion keywords until DOCS-03/DOCS-04 replace
the remaining contract prose checks.

Milestone 9 (Live Workflow Execution) is foundation work. M9 owns live executor
wrappers after NGX-331; see internal/milestones/m9-live-workflow-execution.md
and internal/contracts/live-workflow-execution.md. It does not remain deferred
past M8 closeout.

M10 planning pinned workflow-first runtime scope in internal/milestones/m10-workflow-first-runtime.md; workflow-first dogfood and M10 closeout marker have landed. external-apply and subworkflow production flip have landed.

Accepted planning contract links: internal/contracts/workflow-first-runtime.md,
internal/contracts/executor-loop.md, internal/contracts/workflow-first-gap-matrix.md,
internal/contracts/coding-workflow-ownership.md.

Current deferred/excluded themes: Background runner supervision; Cooperative
shutdown; Manual recovery beyond safe local cases; Single-shot worker;
Configurable workflow execution beyond OpenClaw coding workflows; Worktree
management and remote git operations; Automatic external integrations;
Dashboard or UI surface; Strong sandboxing.

Historical references: internal/milestones/m3-operational-safety.md,
internal/milestones/m4-real-runners.md,
internal/milestones/m5-source-adapters.md,
internal/milestones/m6-external-apply.md,
internal/milestones/m7-openclaw-coding-workflow-backend.md,
internal/milestones/m8-workflow-run-operator-controls.md,
internal/milestones/m9-live-workflow-execution.md,
internal/milestones/m10-workflow-first-runtime.md,
internal/regression-matrix.md, internal/runtime-test-audit.md.
