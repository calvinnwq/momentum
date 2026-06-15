# Momentum Architecture

This file is the repo-level architecture contract. Keep it compact: it orients
contributors, names the import boundaries, and points to deeper contracts rather
than repeating them.

## Current Shape

Momentum is a TypeScript CLI for durable autonomous repo-work orchestration.
The runtime centers on local SQLite state, per-run artifacts, explicit operator
commands, and stable JSON / text envelopes.

The executable entrypoint is intentionally thin. M11 leaves `src/cli.ts` as the
stable parser and compatibility surface while command-family orchestration lives
behind explicit `src/commands/` modules:

```text
src/index.ts -> src/cli.ts -> src/commands/ registry + command families -> domain modules
                                      \-> src/renderers/ shared output contracts
```

`src/cli.ts` owns top-level parsing, global compatibility flags, route
dispatch, and the remaining daemon / recovery / worker / doctor compatibility
surfaces. Extracted command-family modules own the read-only status family,
workflow, goal, source, evidence, project rollup, and update-intent / intent
surfaces. Shared help, IO, reusable source / evidence / intent JSON shapes, and
daemon / recovery / worker / doctor output contracts live under
`src/renderers/`.

Infrastructure-facing clients and runtime adapters that used to sit as flat
`src/` modules now have explicit ownership under `src/adapters/`: database
opening helpers, git transactions, Linear HTTP / source / external-update
adapters and refresh clients, fake / trusted-shell / ACP runner adapters and
configs, live wrapper / harness-probe adapters for OpenClaw-facing execution,
and no-mistakes executor / orchestrator wrappers.

## Deeper Contracts

Use these docs for detailed behavior:

- [README.md](README.md) and [docs/index.md](docs/index.md): public command
  usage and operator documentation.
- [internal/roadmap.md](internal/roadmap.md): milestone timeline and current
  sequencing.
- [internal/contracts/workflow-first-runtime.md](internal/contracts/workflow-first-runtime.md):
  workflow-first runtime model.
- [internal/contracts/executor-loop.md](internal/contracts/executor-loop.md):
  executor invocation and round model.
- [internal/contracts/coding-workflow-ownership.md](internal/contracts/coding-workflow-ownership.md):
  Momentum-owned coding workflow boundary.
- [internal/contracts/runtime-consolidation-plan.md](internal/contracts/runtime-consolidation-plan.md):
  post-M11 runtime keep / deprecate-later / defer decisions and RC follow-ups.
- [internal/contracts/intent-apply.md](internal/contracts/intent-apply.md):
  policy-gated external apply.
- [internal/contracts/source-adapters.md](internal/contracts/source-adapters.md):
  source adapter and evidence-sync boundaries.

## M11 Final Shape

M11 changed structure, not semantics. The final shape is:

```text
src/index.ts              process entrypoint only
src/cli.ts                parser, top-level dispatch, compatibility surfaces
src/commands/             command-family modules
src/renderers/            text / JSON envelope rendering helpers
src/adapters/             infrastructure-facing clients and runtime adapters
existing src domain modules
                          domain state, reducers, policies, persistence helpers
```

The import direction is fixed:

```text
index -> cli -> commands -> renderers
                   |
                   v
            domain modules -> adapters / persistence
```

Domain modules must not import command modules or renderers. Renderers must not
mutate state. Adapters may touch external systems only through explicit command
paths and existing policy gates.

## Command Module Contract

Each command-family module introduced during M11 owns one coherent command
family, for example `workflow`, read-only status, goal, source, evidence,
intent, or project. Daemon, recovery, worker, and doctor remain deliberate
`src/cli.ts` compatibility surfaces, with their output contracts delegated to
`src/renderers/`.

A command module may:

- Parse only the arguments for its command family.
- Call existing domain modules and persistence helpers.
- Return the same exit codes, JSON envelopes, text wording, and refusal codes
  that `src/cli.ts` returned before extraction.
- Share small CLI helpers only through explicit shared modules.

A command module must not:

- Add new product behavior while being extracted.
- Change stable command output as a side effect of movement.
- Reach into another command family's private parser or renderer.
- Bypass existing policy, approval, recovery, or external-write gates.

## M11 Import Boundaries

After M11:

- `src/index.ts` only performs process bootstrap and loads `runCli` from
  `src/cli.ts`; bootstrap-only warning shims must run before `src/cli.ts`
  imports persistence-backed modules.
- `src/cli.ts` imports command-family modules through the explicit command
  registry or direct top-level dispatch and keeps remaining compatibility
  surfaces local.
- Command-family modules may import domain modules, renderers, and shared CLI
  helpers.
- Domain modules stay independent of CLI argv parsing and process IO.
- Renderer modules accept already-computed results and emit stable shapes.
- External adapters stay behind domain or command boundaries with explicit
  policy checks.
- Test fixtures may read source files for structural guards, but production code
  must not depend on filesystem source scanning.

## Adding a Command Module

When adding or extracting a command family:

1. Register the route in the explicit command registry and keep `src/cli.ts`
   responsible only for top-level parsing, compatibility flags, and dispatch.
2. Put command-family parsing and orchestration in `src/commands/<family>/`.
3. Put reusable JSON, text, help, and diagnostic output contracts in
   `src/renderers/`, then have command modules call those renderers with
   already-computed results.
4. Keep persistence, reducers, state machines, and external-write policy checks
   in the existing domain or adapter modules.

Do not import sibling command families for JSON or text render shapes. If two
commands need the same shape, move it to `src/renderers/` first. Do not let
domain modules import commands or renderers, and do not read or write
`process.stdout` / `process.stderr` outside the CLI or rendering layers.

## M11 Closeout

The migration shipped in deliberately staged slices:

1. `NGX-411` pinned this architecture contract and the M11 non-semantic
   structure boundary.
2. `NGX-412` added the command registry skeleton and shared command contract
   with explicit route declarations and no filesystem discovery.
3. `NGX-413` extracted the read-only status family (`status`, `logs`,
   `handoff`, and stable read-only helpers) without changing output.
4. `NGX-414` extracted the workflow command family after the registry exists.
5. `NGX-415` extracted the goal, source, evidence, project, and update-intent
   command families.
6. `NGX-416` consolidated renderers and output contracts.
7. `NGX-417` organized adapters and infrastructure boundaries.
8. `NGX-418` enforced import boundaries with structural guardrails.
9. `NGX-419` closes out M11 with final regression coverage, doctor marker
   advancement, and docs cleanup.

## Stability Rules

- Public command semantics stay frozen unless a later issue explicitly changes
  behavior.
- JSON envelope keys, refusal codes, and text output must be preserved across
  extraction.
- `src/cli.ts` intentionally retains top-level parsing plus daemon, recovery,
  worker, and doctor compatibility surfaces; broad extraction of those surfaces
  belongs to a future scoped issue.
- Public docs stay in `docs/`; milestone sequencing and NGX detail stay in
  `internal/` or this architecture contract when the detail is structural.
- Every extraction should leave the repo valid with focused tests, typecheck,
  and build passing.
