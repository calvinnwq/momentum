# CLI Discovery

Resolve the Momentum command before invoking CLI examples. Do not assume the
current working directory is the Momentum checkout.

## Resolver

From the installed skill directory:

```bash
node "$MOMENTUM_SKILL_DIR/scripts/resolve-momentum-cli.mjs" --json
```

Set `MOMENTUM_SKILL_DIR` to the directory containing `SKILL.md` when the host
does not provide it.

Resolution order:

1. `MOMENTUM_CLI`
2. `momentum` on `PATH`
3. A built Momentum checkout when the current directory, the installed skill
   location, or one of their ancestors has Momentum repo markers and
   `dist/index.js`

If the checkout fallback reports that the repo is not built, run `pnpm build`
from that checkout before retrying.

## Command Shape

The JSON resolver returns:

```json
{
  "ok": true,
  "source": "path",
  "command": "momentum",
  "argv": ["momentum"]
}
```

Append Momentum arguments to `argv` in order. For example, if `argv` is
`["node", "/repo/dist/index.js"]`, the doctor command is:

```bash
node /repo/dist/index.js doctor --json
```

## Baseline Preflight

Run doctor before starting or repairing a run:

```bash
<momentum> doctor --json
```

If doctor fails, report the structured failure and fix setup before continuing.
Do not replace a structured refusal with a guessed command.
