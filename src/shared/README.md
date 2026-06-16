# shared

Cross-cutting support for code with no narrower command, renderer, adapter,
config, or `core/<domain>` owner. This folder is intentionally small; it is not a
generic type dump and should not hide domain behavior that belongs in `src/core/`.

## Local structure

| Concern | Modules |
| --- | --- |
| Queue event names and append helper | `events.ts` |

`events.ts` holds the typed queue-event contract shared by daemon and
goal-compatibility code. It moved from the former root `src/events.ts` under
ARCH-06 / NGX-450 after the root transitional type exceptions were drained.
Because it appends event rows, renderers must not import it at runtime.
