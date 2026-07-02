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
workflow, OpenClaw, goal, source, evidence, project rollup, and update-intent /
intent surfaces. Shared help, IO, reusable source / evidence / intent JSON
shapes, and daemon / recovery / worker / doctor output contracts live under
`src/renderers/`.

Infrastructure-facing clients and runtime adapters that used to sit as flat
`src/` modules now have explicit ownership under `src/adapters/`: database
opening helpers, git transactions, Linear HTTP / source / external-update
adapters and refresh clients, fake / trusted-shell / ACP runner adapters and
configs, live wrapper / harness-probe adapters for OpenClaw-facing execution,
the opt-in coding-workflow live-wrapper CLI adapter, OpenClaw watch-process
adapter, and no-mistakes executor / orchestrator wrappers.

## Deeper Contracts

Use these docs for detailed behavior:

- [README.md](README.md) and [docs/index.md](docs/index.md): public command
  usage and operator documentation.
- [SPEC.md](SPEC.md): compact current runtime, workflow, external-apply,
  source-adapter, coding-workflow ownership, runtime-consolidation, and
  adapter-test contracts.
- Obsidian `/Workspaces/Momentum`: long-form internal plans, contracts,
  milestone provenance, roadmap sequencing, dogfood evidence, readiness notes,
  and migration rationale.

The repo intentionally has no `internal/` documentation tree. Historical
internal planning docs were externalized to Obsidian during DOCS-02/DOCS-03; do
not recreate `internal/`.

There are no standing exceptions for repo-local `internal/` docs.
Any future exception must be explicit, reviewed, and protected by the docs-boundary tests instead of introduced as an ad hoc file.

## M11 Final Shape

M11 changed structure, not semantics. The final shape is:

```text
src/index.ts              process entrypoint only
src/cli.ts                parser, top-level dispatch, compatibility surfaces
src/commands/             command-family modules
src/renderers/            text / JSON envelope rendering helpers
src/adapters/             infrastructure-facing clients and runtime adapters
src/config/               env, path, and default-resolution support
src/shared/               cross-cutting helpers with no narrower domain owner
src/core/<domain>/        workflow, executors, openclaw, goal, source, intent, daemon, repo, evidence
```

The target post-M11 source taxonomy is `src/commands/`, `src/renderers/`,
`src/adapters/`, `src/config/`, `src/shared/`, and `src/core/<domain>/`.
ARCH-02 enforces this with root `src/*.ts` allowlists, transitional exceptions,
placeholder-free pending homes, and import guards; ARCH-03 populated
`src/core/workflow/`, ARCH-04 `src/core/executors/`, and ARCH-05 the remaining
`src/core/<domain>/` (goal, source, intent, daemon, repo, evidence) plus
`src/config/`. ARCH-06 drained the final root type modules into
`src/shared/events.ts`, `src/core/goal/{spec,types}.ts`, and
`src/core/executors/runner/{result,types}.ts`; transitional root exceptions are
now empty. High-density workflow and executor modules are grouped under local
folders documented by each domain `README.md`. Detailed current rules live in
this file and [SPEC.md](SPEC.md); long-form architecture migration rationale
lives in Obsidian `/Workspaces/Momentum`.

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
- All `src/core/<domain>/` modules must not import command or renderer layers.
- Renderer modules accept already-computed results. They may import stable result
  shapes from core modules only with `import type`; runtime imports from
  commands, adapters, persistence, mutation modules, or state-mutating shared helpers stay forbidden.
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
   in the existing domain or adapter modules; do not add root `src/*.ts` support
   files when a narrower owner exists.

Do not import sibling command families for JSON or text render shapes. If two
commands need the same shape, move it to `src/renderers/` first. Do not let
domain modules import commands or renderers, and do not read or write
`process.stdout` / `process.stderr` outside the CLI or rendering layers.

## Adding Source Modules

Do not add new root `src/*.ts` modules. Place new runtime behavior under the
narrowest owner: command orchestration in `src/commands/`, output contracts in
`src/renderers/`, infrastructure adapters in `src/adapters/`, environment and
path defaults in `src/config/`, cross-cutting helpers in `src/shared/`, and
domain behavior in `src/core/<domain>/`.

Transitional exceptions require an explicit owner, exit condition, and guard
test. Prefer moving the type or helper into an existing domain over creating a
new shared bucket.

## M11 Closeout

The M11 migration shipped in deliberate, behavior-preserving slices: `NGX-411`,
`NGX-412`, `NGX-413`, `NGX-414`, `NGX-415`, `NGX-416`, `NGX-417`, `NGX-418`, and
`NGX-419`, which closes out M11 with final regression coverage, doctor marker
advancement, and docs cleanup.

## Stability Rules

- Public command semantics stay frozen unless a later issue explicitly changes
  behavior.
- JSON envelope keys, refusal codes, and text output must be preserved across
  extraction.
- `src/cli.ts` intentionally retains top-level parsing plus daemon, recovery,
  worker, and doctor compatibility surfaces; broad extraction of those surfaces
  belongs to a future scoped issue.
- Public docs stay in `docs/`; milestone sequencing, NGX detail, dogfood
  evidence, and planning rationale live in Obsidian `/Workspaces/Momentum` by
  default. Keep only short repo anchors when the source tree needs a pointer.
- Every extraction should leave the repo valid with focused tests, typecheck,
  and build passing.
