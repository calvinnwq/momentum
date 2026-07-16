# Changelog

## [0.20.0](https://github.com/calvinnwq/momentum/compare/v0.19.0...v0.20.0) (2026-07-16)


### Features

* **executors:** add durable delegated tool supervision ([#229](https://github.com/calvinnwq/momentum/issues/229)) ([405ab05](https://github.com/calvinnwq/momentum/commit/405ab056eb97839982147040c0ad5728d5ba0b8f))

## [0.19.0](https://github.com/calvinnwq/momentum/compare/v0.18.0...v0.19.0) (2026-07-13)


### Features

* add executor registration and SDK dispatch ([#228](https://github.com/calvinnwq/momentum/issues/228)) ([cb9d091](https://github.com/calvinnwq/momentum/commit/cb9d091533ccf99aff93c1a656c9c3f2535c0f34))
* **executors:** add durable executor SDK ([#226](https://github.com/calvinnwq/momentum/issues/226)) ([9d24b00](https://github.com/calvinnwq/momentum/commit/9d24b00f27c0a93962e8f6849cd81ab5ec6dc3a6))
* **workflow:** add portable delegated coding workflow ([#224](https://github.com/calvinnwq/momentum/issues/224)) ([461b18c](https://github.com/calvinnwq/momentum/commit/461b18c035ec7236be7f7a705f133d502de2f842))


### Bug Fixes

* **executors:** fail closed on native Windows ([#227](https://github.com/calvinnwq/momentum/issues/227)) ([628e419](https://github.com/calvinnwq/momentum/commit/628e419418c523d931c93f37b43d709cd193f5ba))

## [0.18.0](https://github.com/calvinnwq/momentum/compare/v0.17.0...v0.18.0) (2026-07-10)

### ⚠ BREAKING CHANGES

- **CLI:** removes the legacy goal-first `goal`, `status`, `logs`, `handoff`, and `worker` commands in favor of the workflow-first surface. ([635dc19](https://github.com/calvinnwq/momentum/commit/635dc19312d01ca46aa7d1ed155802d0b6b9a624), [#218](https://github.com/calvinnwq/momentum/pull/218))
- **Runtime:** removes the legacy goal-iteration and runner-adapter execution substrate; durable compatibility data and operational recovery surfaces remain supported. ([5dbe890](https://github.com/calvinnwq/momentum/commit/5dbe8903f7bc6041bf868769ea32e208e91f391b), [#218](https://github.com/calvinnwq/momentum/pull/218))
- **Daemon:** retires the legacy goal-iteration drain lane while preserving the stable daemon, recovery, and doctor contracts. ([6d95c73](https://github.com/calvinnwq/momentum/commit/6d95c7318f31f7e00c8cb5ecd8e552807cdbe9d7), [#218](https://github.com/calvinnwq/momentum/pull/218))

### Features

- **Operator experience:** adds a public, installable Momentum skill with CLI discovery, workflow, evidence, gate, and recovery guidance. ([6586828](https://github.com/calvinnwq/momentum/commit/6586828cee1fbf527d2d925b449893697fe2b139), [#217](https://github.com/calvinnwq/momentum/pull/217))
- **Goal loop:** adds deterministic round prompts and result files, durable commit-or-reset evidence, and native round state in workflow logs. ([1d01043](https://github.com/calvinnwq/momentum/commit/1d01043d435e0d4bb6eec86a7f54aadbaa0a0c14) prompt rendering, [b5d08de](https://github.com/calvinnwq/momentum/commit/b5d08de916b1abe20d838bdf22c3095914d3d9a4) result files, [a2540e2](https://github.com/calvinnwq/momentum/commit/a2540e2b1e6ae50714038c94bad9bbf55dc1c73f) finalization evidence, [819da1a](https://github.com/calvinnwq/momentum/commit/819da1a9d6e3f053290ce1beff8efbb74edfe103) log projection; [#211](https://github.com/calvinnwq/momentum/pull/211), [#213](https://github.com/calvinnwq/momentum/pull/213))
- **Workflow:** routes live wrappers through native workflow dispatch so execution shares the durable workflow envelope. ([69961c6](https://github.com/calvinnwq/momentum/commit/69961c62d4c8489fd5f87ac05e4b30dee3017dd2), [#216](https://github.com/calvinnwq/momentum/pull/216))
- **Doctor:** reports capability scope instead of milestone-era markers. ([ee316a5](https://github.com/calvinnwq/momentum/commit/ee316a570ac6bacdc3e2ceef8409b3a67110a9df), [#215](https://github.com/calvinnwq/momentum/pull/215))

### Bug Fixes

- **Adapters:** detects semantic stalls in supervised no-mistakes runs. ([bbeaafa](https://github.com/calvinnwq/momentum/commit/bbeaafa0d7acc072e47600c3f92d536a1c60ea0c), [#221](https://github.com/calvinnwq/momentum/pull/221))
- **Daemon:** recovers stale workflow-dispatch runs instead of leaving them wedged. ([0efc06a](https://github.com/calvinnwq/momentum/commit/0efc06aaae61997f415f542053fb04d182ed5ce5), [#223](https://github.com/calvinnwq/momentum/pull/223))
- **Goal loop:** bounds untrusted prompt context and preserves underlying commit/reset failures in manual-recovery evidence. ([6ddd257](https://github.com/calvinnwq/momentum/commit/6ddd25715b1005ca7ce480b0fe0a21e8cef0478a) prompt bounds, [2d0d8ad](https://github.com/calvinnwq/momentum/commit/2d0d8ad1c5cc4f1a1d4572e5b059f626ee536e0a) recovery evidence; [#211](https://github.com/calvinnwq/momentum/pull/211), [#213](https://github.com/calvinnwq/momentum/pull/213))
- **Workflow:** fails watch preflight when its required live-wrapper profile is missing. ([b67647d](https://github.com/calvinnwq/momentum/commit/b67647d9a179c9ee433f013b89c4d003db9216bd), [#210](https://github.com/calvinnwq/momentum/pull/210))

### Quality

- Enforces real lint and formatting gates in local scripts and CI. ([9982bfd](https://github.com/calvinnwq/momentum/commit/9982bfd9fd82ae1bdfe77c93d74862afc62c4b11), [#222](https://github.com/calvinnwq/momentum/pull/222))
- Keeps breaking pre-1.0 releases on minor version increments instead of jumping to `1.0.0`. ([41902cb](https://github.com/calvinnwq/momentum/commit/41902cb6d0529294ea19f8806b17430e2645e0e4), [#220](https://github.com/calvinnwq/momentum/pull/220))

## [0.17.0](https://github.com/calvinnwq/momentum/compare/v0.16.3...v0.17.0) (2026-07-06)


### Features

* **workflow:** Implemented the first NGX-584 slice: issue-scoped linear-refresh now deterministically seeds a missing Linear status_update intent and applies it, verified by focused tests plus pnpm test, pnpm typecheck, pnpm build, and git diff --check HEAD. ([56956f6](https://github.com/calvinnwq/momentum/commit/56956f6b7edb71390fb77c493f4aa8423ecff0b9))
* **workflow:** recover linear-refresh status update intents ([5e86be6](https://github.com/calvinnwq/momentum/commit/5e86be64034b2a87d4dfaa9af408f349ca534536))


### Bug Fixes

* **workflow:** NGX-584 already-applied linear-refresh replay evidence now reports top-level resultCode="already_applied" and all configured focused gates passed; current HEAD before the orchestrator commit is 2dc3c79. ([99403b4](https://github.com/calvinnwq/momentum/commit/99403b4362c1452403b7284259535fe74473dc73))

## [0.16.3](https://github.com/calvinnwq/momentum/compare/v0.16.2...v0.16.3) (2026-07-06)


### Bug Fixes

* **workflow:** require deterministic no-mistakes runner profiles ([95c1fc9](https://github.com/calvinnwq/momentum/commit/95c1fc9d2168be3352d79b3ca3a9ebf0d30fda6f))
* **workflow:** require no-mistakes runner profile ([a6a74de](https://github.com/calvinnwq/momentum/commit/a6a74def9b0c4c2ba58bbdd31c233c86b8803dc4))
* **workflow:** resolve no-mistakes config aliases ([9476c4e](https://github.com/calvinnwq/momentum/commit/9476c4ed7b5b27dc2eb29dc9ae1823fb7c8a385e))

## [0.16.2](https://github.com/calvinnwq/momentum/compare/v0.16.1...v0.16.2) (2026-07-03)


### Bug Fixes

* **workflow:** anchor compact no-mistakes cancellation ([857a933](https://github.com/calvinnwq/momentum/commit/857a933bace41c0c972d3e75999f038fa2f78180))
* **workflow:** classify cancelled no-mistakes status for retry ([04ec54c](https://github.com/calvinnwq/momentum/commit/04ec54c4df8aa785ce12fcce38ff301f396cb204))
* **workflow:** detect stalled no-mistakes mirror state ([9c9eba8](https://github.com/calvinnwq/momentum/commit/9c9eba875f2457be299f03ea55ff295d3c22c721))
* **workflow:** gate compact no-mistakes cancellation context ([c544ce5](https://github.com/calvinnwq/momentum/commit/c544ce54b46d0412bf08bd3a34bfb9fa513d2c63))
* **workflow:** handle nested no-mistakes cancellation evidence ([e49d732](https://github.com/calvinnwq/momentum/commit/e49d7324b70d10ff792bc08f3fe6d44c3098a231))
* **workflow:** parse no-mistakes cancellation context safely ([492f026](https://github.com/calvinnwq/momentum/commit/492f026c9c876bf4bd7d826ecfe5e1aceefe599d))
* **workflow:** preserve no-mistakes cancellation context ([df7fb6e](https://github.com/calvinnwq/momentum/commit/df7fb6e3af66b8962f5c004c73d71937352b9a69))
* **workflow:** recover stalled no-mistakes runs ([5a965a1](https://github.com/calvinnwq/momentum/commit/5a965a187492543bc1a8c137e5044a204d4bd887))
* **workflow:** require current no-mistakes cancellation ancestry ([1c123e1](https://github.com/calvinnwq/momentum/commit/1c123e1291511ef30b2e568ca085bfbb5aa0e4c6))

## [0.16.1](https://github.com/calvinnwq/momentum/compare/v0.16.0...v0.16.1) (2026-07-03)


### Bug Fixes

* **workflow:** Added a focused NGX-575 readiness slice so malformed native coding route JSON now fails closed with compact structural preflight evidence before durable writes. ([2a88508](https://github.com/calvinnwq/momentum/commit/2a885084d7a1b9082a8a7a46ea3b73801b657832))
* **workflow:** fail closed on malformed native coding routes ([e592c9a](https://github.com/calvinnwq/momentum/commit/e592c9a448559507910a0e3414d2eb298cd511e3))
* **workflow:** keep watch from starting tail steps ([6c047d8](https://github.com/calvinnwq/momentum/commit/6c047d80af1476b3875c36d2d988e118e84f5a99))
* **workflow:** require operator action for watch tail steps ([23ef9ad](https://github.com/calvinnwq/momentum/commit/23ef9adfba4cf17ba152775bc488aa66160b73c0))

## [0.16.0](https://github.com/calvinnwq/momentum/compare/v0.15.0...v0.16.0) (2026-07-02)

0.16.0 is a native workflow hardening release. It makes coding workflow startup fail earlier and more clearly, makes recovery/readback surfaces easier to consume, and tightens the lifecycle for external tail steps like merge cleanup and Linear refresh.

### Highlights

* Native coding workflow preflight now validates workflow definition resolution, approval boundaries, route profiles, route steps, wrapper config shape, issue scope, repo inputs, and required objectives before execution proceeds. Invalid inputs now return compact structural evidence instead of drifting into later runtime failures. ([1fb7390](https://github.com/calvinnwq/momentum/commit/1fb7390171c559855afc6854d8e10459911e94c3), [71527d3](https://github.com/calvinnwq/momentum/commit/71527d38937b71848dd95b6f425b12213ebef9c4))
* Recovery readbacks now use a clearer shared `nextAction` contract across monitor, status, watch, and handoff-style surfaces, including action classes and recovery detail where they are meaningful. ([14e472a](https://github.com/calvinnwq/momentum/commit/14e472af4ce41d95018076ededaac223dc2a0e75), [27ee520](https://github.com/calvinnwq/momentum/commit/27ee520ffdb284e5cfd69691e58703f629df01c5))
* No-mistakes recovery can reconcile interrupted runs from deterministic checks-passed evidence, while ordinary failed no-mistakes steps remain normal retryable failures. ([4c579bd](https://github.com/calvinnwq/momentum/commit/4c579bd5af56487ee29e0b64ac9e7f48c64d74d7), [27ee520](https://github.com/calvinnwq/momentum/commit/27ee520ffdb284e5cfd69691e58703f629df01c5))
* Merge cleanup and Linear refresh tails now have stronger preflight, audit, reconciliation, and recovery behavior for external side effects. ([b72b855](https://github.com/calvinnwq/momentum/commit/b72b855a1e7262cd524a978639d7e14cc59f4dae), [fb8c95e](https://github.com/calvinnwq/momentum/commit/fb8c95edba9a0c1d40a031da629da51a0fa16e0e))
* The native goal-loop contract is now documented, including invocation and round evidence, completion recommendations, verification results, artifacts, learnings, and recovery metadata. ([7e9f2f3](https://github.com/calvinnwq/momentum/commit/7e9f2f352de6ad3ae72d4645b4c3f0652539340d))

### Operator Notes

* `workflow run preview-coding` and `workflow run start-coding` now reject malformed native workflow inputs earlier, including blank repo values, missing objectives, invalid approval boundaries, missing built-in definitions, malformed route config, and unsafe wrapper config fields.
* `reconcile_deterministic_evidence` is now reserved for explicit interrupted no-mistakes evidence recovery. A plain failed no-mistakes step should surface as `retry_failed_step` with no recovery detail.
* Merge cleanup and Linear refresh remain external-write tail steps. They should reconcile from durable evidence and explicit intent instead of replaying writes blindly.
* Documentation and architecture anchors were refreshed around the native goal-loop direction and workflow/executor module ownership.

## [0.15.0](https://github.com/calvinnwq/momentum/compare/v0.14.4...v0.15.0) (2026-07-01)


### Features

* add OpenClaw supervisor runner ([0c967ae](https://github.com/calvinnwq/momentum/commit/0c967ae7d49efe2e295be700947e48013052c01c))
* **cli:** add OpenClaw supervisor ([57c457d](https://github.com/calvinnwq/momentum/commit/57c457da12f0a55d1ab01cc090e750c11b521c6b))
* **ngx-546:** dedupe duplicate linear source rows in project status ([5f17267](https://github.com/calvinnwq/momentum/commit/5f172678d3d2eec85f739cf154816456f5261c31))
* **openclaw:** add delivery intent contract ([d17648e](https://github.com/calvinnwq/momentum/commit/d17648e837946a7fe3f4e29694323b2ce24bc2ee))
* **openclaw:** add delivery intent evidence ([ebc9fee](https://github.com/calvinnwq/momentum/commit/ebc9feeed34137d87a77d99e3c6528fff45663c7))
* **openclaw:** add supervise help output ([b795b66](https://github.com/calvinnwq/momentum/commit/b795b66f54216e44ad6d5216f601efe0f9e9dd54))
* **openclaw:** audit safe supervisor auto-actions ([f5d918e](https://github.com/calvinnwq/momentum/commit/f5d918e238f416b448d950a38c9474f0ed5f9f5e))
* **openclaw:** audit safe supervisor auto-actions ([9b39d53](https://github.com/calvinnwq/momentum/commit/9b39d5348060c075b525e2d7aa6ab7328064fbda))
* **workflow:** add durable DB poll source for watch stream ([5529b7b](https://github.com/calvinnwq/momentum/commit/5529b7ba2202c86ec694ea2b91739777cfd1accf))
* **workflow:** add durable run event replay cursor ([2962c84](https://github.com/calvinnwq/momentum/commit/2962c84728dc29a2df295aaae5c4f7ce45c91335))
* **workflow:** add durable workflow event replay ([5f4a13f](https://github.com/calvinnwq/momentum/commit/5f4a13f841cfb67cb82c51ea49073292dd498b37))
* **workflow:** add JSONL stream-tick reducer for watch --stream --jsonl ([9aa1cae](https://github.com/calvinnwq/momentum/commit/9aa1caed21c30e519012aed48e787f673303640c))
* **workflow:** add JSONL watch stream mode ([9d805c0](https://github.com/calvinnwq/momentum/commit/9d805c06c9b0b3a3fd75f96bc61503da95558b5f))
* **workflow:** add quiet watch advisories ([fc9b2d8](https://github.com/calvinnwq/momentum/commit/fc9b2d87b2343b2426ab119d509458d5b588c430))
* **workflow:** add quiet watch stuck-risk advisories ([6ca9894](https://github.com/calvinnwq/momentum/commit/6ca98943a827161fd680833c4a1a8fc63d7f269a))
* **workflow:** add runWorkflowWatchStream session driver ([e8c5454](https://github.com/calvinnwq/momentum/commit/e8c54546e5001deb739b4d2d733f73acf6d47f99))
* **workflow:** add supervisor action authority policy ([de7cb7e](https://github.com/calvinnwq/momentum/commit/de7cb7e621538153dce51580d7991aa00907c65d))
* **workflow:** add supervisor action authority policy ([6905563](https://github.com/calvinnwq/momentum/commit/690556391c0b04508c423bd11ed3e839a434d088))
* **workflow:** add workflow run watch --once supervisor tick ([ede228a](https://github.com/calvinnwq/momentum/commit/ede228afb51b878979b798dd53253c330f49ab72))
* **workflow:** add workflow run watch once supervisor tick ([7ca8fda](https://github.com/calvinnwq/momentum/commit/7ca8fda36c6f3e7a2beac894807dbf4130e23f7b))
* **workflow:** freeze GUI-ready monitor contract ([41b8355](https://github.com/calvinnwq/momentum/commit/41b8355da821c477a519e7aaf5255e7dfef25fcd))
* **workflow:** freeze supervisor envelope contract ([82276a2](https://github.com/calvinnwq/momentum/commit/82276a21b45106db65d0ba1e0fb95c273c689dec))
* **workflow:** wire workflow run watch --stream --jsonl CLI mode ([cc3d3e6](https://github.com/calvinnwq/momentum/commit/cc3d3e634732e0f80e950a8f09d9685c523ac9e6))


### Bug Fixes

* **openclaw:** align audit failure state repair ([2d02164](https://github.com/calvinnwq/momentum/commit/2d0216435e5820a86ba600b69b2cfcd1960f9348))
* **openclaw:** align failed auto-action audit state ([d1f297a](https://github.com/calvinnwq/momentum/commit/d1f297a56e9b02c8dc838ce7166be9e7a9901e7f))
* **openclaw:** audit release persistence before disabling monitors ([bdb494f](https://github.com/calvinnwq/momentum/commit/bdb494f8e1328c4aedeb6b9c79d1da599a44058c))
* **openclaw:** bound disabled monitor release audits ([f90f0cd](https://github.com/calvinnwq/momentum/commit/f90f0cdc1509ae9d75d8f6a11575971eb7285e1b))
* **openclaw:** count saved release audits monotonically ([1ae4bb2](https://github.com/calvinnwq/momentum/commit/1ae4bb2f512551726234961542a366d717fde834))
* **openclaw:** focus supervise help ([f494c66](https://github.com/calvinnwq/momentum/commit/f494c66683dcc49d66a489234a5e21cfe024a70f))
* **openclaw:** preserve auto-action escalation delivery text ([2df61a6](https://github.com/calvinnwq/momentum/commit/2df61a6630ee9871af1267615c65bcd215d949a0))
* **openclaw:** require final auto-action audit status ([58aa4b6](https://github.com/calvinnwq/momentum/commit/58aa4b63eeebcd984b055b19adfaf2b44c4cf01f))
* **openclaw:** require policy before monitor cleanup ([5053229](https://github.com/calvinnwq/momentum/commit/505322945d7b345e29508839da71b24c0df86ede))
* **openclaw:** suppress cleanup on audit escalation ([37631fc](https://github.com/calvinnwq/momentum/commit/37631fcc48209644f60284629261ef9ec36f5cdb))
* **openclaw:** suppress repeated auto-action escalations ([5ef6334](https://github.com/calvinnwq/momentum/commit/5ef6334aeed562ca7f950be33aedabac81e3add2))
* preserve OpenClaw source runner loader ([8475340](https://github.com/calvinnwq/momentum/commit/847534096b2bee8ca6f90ec5ff23c2637bc39141))
* **project:** handle legacy Linear metadata in project status ([715da25](https://github.com/calvinnwq/momentum/commit/715da25d77df56204dbfa70c1ed4cf3d66d9408b))
* **project:** NGX-545 handle legacy scalar project milestone metadata ([55ac4e3](https://github.com/calvinnwq/momentum/commit/55ac4e31484d694a4832552aff2f4d7b1c32f479))
* **project:** preserve source alias evidence links ([e873a48](https://github.com/calvinnwq/momentum/commit/e873a488c30885a288464967e80e9dc9e5ffe8a7))
* **project:** preserve typed metadata filter matching ([4bb6d09](https://github.com/calvinnwq/momentum/commit/4bb6d09cbf8aef4138feb075b59f07a6740e6f44))
* **repo:** dedupe Linear project status sources ([0ea0460](https://github.com/calvinnwq/momentum/commit/0ea04609914476b700f68b022b512863f2034b91))
* **workflow:** expose gate action policy in detail envelopes ([263230f](https://github.com/calvinnwq/momentum/commit/263230ffe41240ab0c71dce637cd9826a82e9116))
* **workflow:** honor jsonl watch validation failures ([828d17a](https://github.com/calvinnwq/momentum/commit/828d17acb632152127f9eeb68f94a86bcdfff749))
* **workflow:** keep event replay identities stable ([d59a048](https://github.com/calvinnwq/momentum/commit/d59a0480f1701915156362fdaae32843dec1ffcd))
* **workflow:** keep external-tail polling auto-allowed ([66b350b](https://github.com/calvinnwq/momentum/commit/66b350b12e6dfb6a54ad7265e0a0873a9a19c085))
* **workflow:** mark terminal watch stream closure ([f706c86](https://github.com/calvinnwq/momentum/commit/f706c86b0359263e29d82219e2e6ffa98eab1c10))
* **workflow:** order replay events by lifecycle ([809f955](https://github.com/calvinnwq/momentum/commit/809f9556983957876e48ea26f2cfa9743eec7aaa))
* **workflow:** preflight external adapter auth ([881bf92](https://github.com/calvinnwq/momentum/commit/881bf9286d57c9e5fe773e02b5029018c522aa21))
* **workflow:** preflight external adapter auth ([c407aeb](https://github.com/calvinnwq/momentum/commit/c407aebbda6e6dabd37a3dc0f3f4d3167250c86b))
* **workflow:** preserve jsonl stream terminal contracts ([863d922](https://github.com/calvinnwq/momentum/commit/863d922b45a77c7b1d30f6508bb949b6d33bdc8a))
* **workflow:** preserve recovered step failure events ([73aa7dc](https://github.com/calvinnwq/momentum/commit/73aa7dcdf47de0b4a324bf15cc902c6e36df0d23))
* **workflow:** preserve replay transitions across recovery ([1d60fe7](https://github.com/calvinnwq/momentum/commit/1d60fe7a5105f4ad5111e6db489eb062a9eedc9c))
* **workflow:** reconcile interrupted no-mistakes recovery ([51595b8](https://github.com/calvinnwq/momentum/commit/51595b8db22693cd2a385f0de5010ff693cd7990))
* **workflow:** reconcile interrupted no-mistakes success ([2d97cc9](https://github.com/calvinnwq/momentum/commit/2d97cc90c5d52a777c73f9c5dd85c2b76a9d581b))
* **workflow:** reject invalid event replay cursors ([1b33c2e](https://github.com/calvinnwq/momentum/commit/1b33c2e53a975073e4d56982ae55dc058e61c1fe))
* **workflow:** repair auth preflight recovery ([c2433c8](https://github.com/calvinnwq/momentum/commit/c2433c8642736d8bdf05636e0dcf2a92280c5c8e))
* **workflow:** replay imported terminal run events ([41a5087](https://github.com/calvinnwq/momentum/commit/41a5087504277f5f6999e2d4c0df54e2d5c18ba3))
* **workflow:** tighten no-mistakes recovery evidence ([0fe8783](https://github.com/calvinnwq/momentum/commit/0fe8783ad174b3b07740daead95a8474683f3dfb))
* **workflow:** tolerate legacy event replay schemas ([66d8fdf](https://github.com/calvinnwq/momentum/commit/66d8fdf23e26b93f9074c6fa5530a0b12b9f008d))

## [0.14.4](https://github.com/calvinnwq/momentum/compare/v0.14.3...v0.14.4) (2026-06-25)


### Bug Fixes

* **workflow:** ignore stale recovery flag for terminal monitor progress ([e6b4905](https://github.com/calvinnwq/momentum/commit/e6b4905751816c378b5e045f8f2531f24a24e6df))
* **workflow:** ignore stale terminal monitor recovery flags ([3515277](https://github.com/calvinnwq/momentum/commit/3515277f9355969e2f05d5fccbaae26a8f3566d7))
* **workflow:** keep reconciled terminal monitor progress clean ([64aa497](https://github.com/calvinnwq/momentum/commit/64aa4976671f8d78e35258cbfcfb2f9ffb19244d))
* **workflow:** keep terminal monitor progress clean ([7a86687](https://github.com/calvinnwq/momentum/commit/7a86687d84d1253c638a0be1b265f3db81af0726))

## [0.14.3](https://github.com/calvinnwq/momentum/compare/v0.14.2...v0.14.3) (2026-06-25)


### Bug Fixes

* **workflow:** accept no-mistakes checks-passed evidence ([64be97e](https://github.com/calvinnwq/momentum/commit/64be97e53aab921f104a119b13476b65c0c46b8c))

## [0.14.2](https://github.com/calvinnwq/momentum/compare/v0.14.1...v0.14.2) (2026-06-25)


### Bug Fixes

* **workflow:** park no-mistakes lifecycle failures ([0d6850c](https://github.com/calvinnwq/momentum/commit/0d6850c065415d50326b8cfc660bb84d39b48b06))

## [0.14.1](https://github.com/calvinnwq/momentum/compare/v0.14.0...v0.14.1) (2026-06-25)


### Bug Fixes

* **workflow:** recover missing native wrapper config ([6bbf157](https://github.com/calvinnwq/momentum/commit/6bbf157232b0ba93db41f0a3ebebf30f9ef76afe))

## [0.14.0](https://github.com/calvinnwq/momentum/compare/v0.13.0...v0.14.0) (2026-06-25)


### Features

* **intent:** support Linear status update external apply ([#157](https://github.com/calvinnwq/momentum/issues/157)) ([05bf906](https://github.com/calvinnwq/momentum/commit/05bf906b472cdc51e2078ebd53a9899917e9724c))

## [0.13.0](https://github.com/calvinnwq/momentum/compare/v0.12.0...v0.13.0) (2026-06-24)


### Features

* **workflow:** expand native route model alias coverage ([66ad910](https://github.com/calvinnwq/momentum/commit/66ad9102429bcd019a281054d3e90053828308ad))
* **workflow:** normalize Claude coding route model aliases ([fdd9e50](https://github.com/calvinnwq/momentum/commit/fdd9e50179d9a940ae47f9e160cfd7501627f243))

## [0.12.0](https://github.com/calvinnwq/momentum/compare/v0.11.0...v0.12.0) (2026-06-24)


### Features

* **workflow:** add --advance progress suppression writer to run monitor (NGX-511) ([f594874](https://github.com/calvinnwq/momentum/commit/f5948746b007e17678e5f4c3c44fbfe9a7c52083))
* **workflow:** add native progress monitor digest ([2b4ea8a](https://github.com/calvinnwq/momentum/commit/2b4ea8aca56d9a489773df1dbbeaca23011ef42d))
* **workflow:** add per-step coding route configuration ([a5b99c4](https://github.com/calvinnwq/momentum/commit/a5b99c4878beba9cddacc55691e008ab64b8e5d0))
* **workflow:** add pure native progress-monitor digest keystone (NGX-511) ([f62f6f8](https://github.com/calvinnwq/momentum/commit/f62f6f892ef3cc2eb3767ca5215785addcc2c590))
* **workflow:** add pure per-step coding route-config keystone module ([54db337](https://github.com/calvinnwq/momentum/commit/54db337e0d08b7f0b6226c893c7282de0bfd0748))
* **workflow:** render per-step route selections in preview-coding text ([336fc00](https://github.com/calvinnwq/momentum/commit/336fc008cda3137ae7adc74f7239265fb4eb8a3f))
* **workflow:** wire --steps-json per-step route overrides into coding doors ([460aa43](https://github.com/calvinnwq/momentum/commit/460aa43c849e02397b92ccee499f06a62375869f))
* **workflow:** wire progress-digest reducer into workflow run monitor (NGX-511) ([59a849f](https://github.com/calvinnwq/momentum/commit/59a849f3af27408c0a0d47deb87e6d41e18eb24b))


### Bug Fixes

* **cli:** handle nested workflow run help ([e7298c5](https://github.com/calvinnwq/momentum/commit/e7298c567e8747f5967eefb986270fa88cb65e57))
* **workflow:** reconcile external tail recovery with evidence ([c24ea48](https://github.com/calvinnwq/momentum/commit/c24ea48f1886196ae8ec4c2302566ea75d60494a))

## [0.11.0](https://github.com/calvinnwq/momentum/compare/v0.10.0...v0.11.0) (2026-06-23)


### Features

* **workflow:** add native coding plan preview ([0f11c61](https://github.com/calvinnwq/momentum/commit/0f11c61ed22786737da54e21777649859d61f7e0))
* **workflow:** add read-only workflow run preview-coding plan door ([3ff0626](https://github.com/calvinnwq/momentum/commit/3ff0626d1b881e684c75f9bca8494a1ba99b81cd))

## [0.10.0](https://github.com/calvinnwq/momentum/compare/v0.9.1...v0.10.0) (2026-06-22)


### Features

* **workflow:** add explicit Momentum-native coding-workflow start door ([a6babc4](https://github.com/calvinnwq/momentum/commit/a6babc454bd7781452737c452992814a727ca75a))
* **workflow:** add native coding start command ([f4157fe](https://github.com/calvinnwq/momentum/commit/f4157feff0ae7e15730fc05d9f9f4760d7a1fec7))


### Bug Fixes

* **workflow:** harden built-in definition version dispatch ([bd07ea4](https://github.com/calvinnwq/momentum/commit/bd07ea4030cd002f10be2ae8efd2f79f5b5dd47c))

## [0.9.1](https://github.com/calvinnwq/momentum/compare/v0.9.0...v0.9.1) (2026-06-22)


### Bug Fixes

* harden workflow dispatch recovery retry ([b8b3e4c](https://github.com/calvinnwq/momentum/commit/b8b3e4c01c5f293250093da5004147f56f7a3aea))
* **workflow:** harden dispatch recovery retry ([fa39901](https://github.com/calvinnwq/momentum/commit/fa39901898696d3e3e114899a61baefd530fd4e2))

## [0.9.0](https://github.com/calvinnwq/momentum/compare/v0.8.0...v0.9.0) (2026-06-21)


### Features

* **workflow:** add Momentum-native dogfood workflow profile ([af4f77f](https://github.com/calvinnwq/momentum/commit/af4f77f8b72b30cabd96ed4a71dec2969c5fb3c9))
* **workflow:** add NGX-499 dogfood wrapper profile ([d39d74d](https://github.com/calvinnwq/momentum/commit/d39d74d8f4adb32d9e94f307dcc2ad171b8abaaa))

## [0.8.0](https://github.com/calvinnwq/momentum/compare/v0.7.0...v0.8.0) (2026-06-21)


### Features

* **workflow:** enable production subworkflow dispatch for configured steps through bounded daemon start, child-definition resolution, recursion-safe routing, terminal evidence mirroring, and dogfood proof ([491a456](https://github.com/calvinnwq/momentum/commit/491a45611ac7442892fa124074e36aac28671608))
* **workflow:** add child-definition config, recursion lineage, and daemon-lane context derivation for production subworkflow dispatch ([4e99e73](https://github.com/calvinnwq/momentum/commit/4e99e73af093f6aa5eff76b722edbc2504bbf025), [21c3dfe](https://github.com/calvinnwq/momentum/commit/21c3dfe0e86443f4ee631db65fe59cace55a06c0), [e750933](https://github.com/calvinnwq/momentum/commit/e750933ae0b0320160a2ee7663b289aac4180517))
* **workflow:** add a key-resolved start-or-attach child-runner for subworkflow dispatch through workflow-owned seams ([273b3cf](https://github.com/calvinnwq/momentum/commit/273b3cff7aaf121a71ebfdf64c3ac317f2360a4d), [511dc81](https://github.com/calvinnwq/momentum/commit/511dc8197b4126fa1c807be6bdbc997c29cecf91))


### Bug Fixes

* **workflow:** harden subworkflow dispatch handoff ([ade9252](https://github.com/calvinnwq/momentum/commit/ade9252e41051169d52fca7def19a771ac05d6c6))

## [0.7.0](https://github.com/calvinnwq/momentum/compare/v0.6.0...v0.7.0) (2026-06-20)


### Features

* **workflow:** add subworkflow adapter mechanism ([ad9c0ed](https://github.com/calvinnwq/momentum/commit/ad9c0ed4d445dd7dfa3bb79db8b227d2849e6a3f))
* **workflow:** add async subworkflow producer that observes a child workflow run and mirrors terminal child evidence into RC-2 finalization ([c31a8fe](https://github.com/calvinnwq/momentum/commit/c31a8fe348832f488e66da7bc8a675d6c5ead32d))
* **workflow:** add pure child-run mirror planning for subworkflow executor evidence ([cfdd356](https://github.com/calvinnwq/momentum/commit/cfdd35626531cd876b1eb9fba8e736b5673e40ba))
* **workflow:** add subworkflow dispatch entry-point factory for the workflow dispatch seam ([299591e](https://github.com/calvinnwq/momentum/commit/299591ebce44e85165efe6a2927b4f9a693b6fe8))

## [0.6.0](https://github.com/calvinnwq/momentum/compare/v0.5.0...v0.6.0) (2026-06-20)


### Features

* **workflow:** Landed the async daemon-dispatchable external-apply producer for RC-3 (NGX-496): executeAndReconcileDispatchedExternalApplyStep runs the injected M6 write path, maps it via the landed pure mapping, records terminal executor evidence, and lets RC-2 finalize the step exactly once — with an idempotent-re-entry guard that never re-runs the external write. ([15a73c9](https://github.com/calvinnwq/momentum/commit/15a73c93fa72071480229c655f74c777c27a30aa))
* **workflow:** Landed the pure, reusable core of RC-3 (NGX-496): a tested mapping from M6 external-apply outcomes into the dispatched-step executor evidence the existing terminalize/RC-2 seams consume, with applied→succeeded and every failure→fail-closed manual recovery. ([dd8f576](https://github.com/calvinnwq/momentum/commit/dd8f576cea99734b3d241ccfe667f0ebd96b8918))
* **workflow:** make external-apply daemon-dispatchable ([008551e](https://github.com/calvinnwq/momentum/commit/008551e2cb8f56214fe81a650030b2141f1767bc))

## [0.5.0](https://github.com/calvinnwq/momentum/compare/v0.4.0...v0.5.0) (2026-06-19)


### Features

* **workflow:** add daemon-default live-wrapper profile source resolver (NGX-492) ([b95be38](https://github.com/calvinnwq/momentum/commit/b95be3891cffbdf7bf63ca8b1a855140edb70a5a))
* **workflow:** add daemon-lane exec-context deriver for dispatched steps (NGX-492) ([b227ace](https://github.com/calvinnwq/momentum/commit/b227ace904759982f29544669e6d49391783d0b0))
* **workflow:** add dispatched-step executor terminalization seam for RC-5b (NGX-492) ([33514a6](https://github.com/calvinnwq/momentum/commit/33514a60f4a97142a3b4ab48abd1ce445c7dcbd1))
* **workflow:** add live-wrapper dispatch composition for daemon lane (NGX-492) ([67993c6](https://github.com/calvinnwq/momentum/commit/67993c6c6e507540c32ac4bf6c89bd44dde17d31))
* **workflow:** compose run-executor-terminalize-reconcile path for dispatched steps (NGX-492) ([43633bd](https://github.com/calvinnwq/momentum/commit/43633bd30c760db16a701a37c188d0082fdb12aa))
* **workflow:** route daemon dispatch through live-wrapper profiles ([d907166](https://github.com/calvinnwq/momentum/commit/d907166fa6fb24b6b632eae45b0a94678b5d135f))
* **workflow:** route non-derivable exec context to manual recovery in live-wrapper dispatch (NGX-492) ([90cbedf](https://github.com/calvinnwq/momentum/commit/90cbedf98edb09b034e23b046ece98b96154e954))

## [0.4.0](https://github.com/calvinnwq/momentum/compare/v0.3.0...v0.4.0) (2026-06-19)


### Features

* **workflow:** add run-scoped logs read-back ([6c70bc3](https://github.com/calvinnwq/momentum/commit/6c70bc34434524d86ed2227f8b9229f3510b6334))
* **workflow:** add workflow run logs command and listExecutorRoundsForRun for RC-1 read-back parity (NGX-486) ([a49ef54](https://github.com/calvinnwq/momentum/commit/a49ef54ec219df9e290a52fe1e8b4d167abadefd))

## [0.3.0](https://github.com/calvinnwq/momentum/compare/v0.2.0...v0.3.0) (2026-06-19)


### Features

* **core:** use real WorkflowStepExecutor adapters ([6f68ad3](https://github.com/calvinnwq/momentum/commit/6f68ad37c2b6fc19bac6ee8f0f987bd44d98d83c))
* **step-executor:** Landed the foundational RC-5 slice: a real, TDD-tested WorkflowStepExecutor production adapter-registry builder that reuses the M9 live-wrapper boundary for configured kinds and reports honest runtime_unavailable (never a fake success) for unconfigured kinds. ([c429c8c](https://github.com/calvinnwq/momentum/commit/c429c8ca078a66bbb8853f55f460b4a4026ebbf3))

## [0.2.0](https://github.com/calvinnwq/momentum/compare/v0.1.1...v0.2.0) (2026-06-19)


### Features

* **rc-2:** Landed the production RC-2 reconciliation effect twin (reconcileDispatchedWorkflowStep) for NGX-480, finalizing a dispatched M10 workflow step from terminal executor evidence idempotently and single-owner, with 10 focused TDD tests and all repo gates green. ([42bb7d4](https://github.com/calvinnwq/momentum/commit/42bb7d4af4b76e1174cadbf017c576981e371a28))
* **rc-2:** Landed the pure RC-2 reconciliation decider (planWorkflowStepReconciliation) for NGX-480 via TDD, mapping a dispatched step's terminal executor-invocation evidence to a workflow-step finalization decision, with all repo verification gates green. ([9947ebe](https://github.com/calvinnwq/momentum/commit/9947ebe91d1cadd02c442d6f6d3b80adda6642e0))
* **workflow:** reconcile dispatched step finalization ([9ce4439](https://github.com/calvinnwq/momentum/commit/9ce4439c4b4235904c64e442a492a5e2d355f5a7))

## [0.1.1](https://github.com/calvinnwq/momentum/compare/v0.1.0...v0.1.1) (2026-06-17)


### Bug Fixes

* **release:** use plain version tags ([d73ec50](https://github.com/calvinnwq/momentum/commit/d73ec50fd0a46a726630da0c69abf37fcc131757))
* **release:** use plain version tags ([d73cfbe](https://github.com/calvinnwq/momentum/commit/d73cfbe9bb3297b913e568cb482f30be8d58a626))

## 0.1.0 (2026-06-16)


### Features

* add durable workflow definition primitives ([0e662c2](https://github.com/calvinnwq/momentum/commit/0e662c285f34c8dec4648fbdc0f757313662e7c1))
* add live workflow finalization recovery ([4d007ac](https://github.com/calvinnwq/momentum/commit/4d007ace12e2c41880484c3747cbe21334718139))
* add Momentum command registry skeleton ([28832a5](https://github.com/calvinnwq/momentum/commit/28832a52181840a4b00adc50d3778f3664c80ef1))
* add Momentum command registry skeleton ([2673948](https://github.com/calvinnwq/momentum/commit/26739481dbe2dc8c272d3f1140f8a878717b1af1))
* add one-shot and script executor adapters ([6e835e7](https://github.com/calvinnwq/momentum/commit/6e835e7f9586672cf35cd8eaf4463bd91021faff))
* add run-scoped workflow recovery controls ([f398588](https://github.com/calvinnwq/momentum/commit/f398588a2be212ac35811a1946cb0a3aacb64664))
* **cli:** add workflow run start ([6b26a6c](https://github.com/calvinnwq/momentum/commit/6b26a6c1ce292d09a8ecfe0297b61cbdd931cdf1))
* **daemon:** add opt-in workflow scheduler lane ([6179aea](https://github.com/calvinnwq/momentum/commit/6179aeaeffff89f6d5eb27554ce6f168a998c381))
* **daemon:** dispatch production workflow steps ([5bba1f2](https://github.com/calvinnwq/momentum/commit/5bba1f26d2375d81280920afec98cf815e04497a))
* **dispatch:** Landed the durable read-only resolution twin of the NGX-367 dispatch brain — resolveClaimedWorkflowStepFamily (run→definition-link→step-definition→executor-family with the full failure taxonomy) plus resolveWorkflowStepDispatchPlan composing iteration 1's pure brain — backed by 10 focused TDD tests; the clean full suite (2986/2986), typecheck, and build all pass. ([d057cd2](https://github.com/calvinnwq/momentum/commit/d057cd2c39238d2aa0ebd326fd903eddf0515d77))
* **dispatch:** Landed the first NGX-367 slice — a pure, total production workflow-lane dispatch decision module (phase-1 executor-family allowlist + fail-closed resolution taxonomy + planWorkflowStepDispatch) with 16 focused TDD tests; typecheck, build, and the targeted tests all pass. ([a71f7f2](https://github.com/calvinnwq/momentum/commit/a71f7f2e212ec67e44ae6f2f09ada6ec283707d4))
* **dispatch:** Landed the side-effecting dispatch twin of the NGX-367 dispatcher — executeWorkflowStepDispatch, a WorkflowStepDispatch-shaped seam that durably creates the executor_invocations/executor_rounds start scaffold (and advances the step) on dispatch, or opens a manual-recovery gate + flag and releases the dispatch lease on fail-closed — backed by 6 TDD tests; typecheck, build, and the full suite (2992) pass. ([5309a1f](https://github.com/calvinnwq/momentum/commit/5309a1f628998c9ae347c5f12820ecf340c1f468))
* **dispatch:** Wired the production workflow-lane dispatcher into the shipped bounded managed `daemon start` path (the named NGX-367 blocker), surfaced workflowStepsDispatched/lastWorkflowCode loop-summary evidence, and backed it with 2 focused TDD tests plus a built-CLI dogfood; full suite (2994), typecheck, and build all pass. ([3450c01](https://github.com/calvinnwq/momentum/commit/3450c012c7ae33624a88b93d0206b851eddd2081))
* **evidence:** add run_id/step_id typed linkage columns and additive migration to evidence_records ([9c59cc2](https://github.com/calvinnwq/momentum/commit/9c59cc2645a8ae2ee426943f2ff60f2d76b646a7))
* **evidence:** Implemented the parser-attach slice of NGX-329: the workflow evidence parser now populates typed runId on every record and stepId on ledger step events, so typed linkage flows end-to-end through evidence ingest into stored rows. ([fcf9910](https://github.com/calvinnwq/momentum/commit/fcf9910173615e57f985e200b1499e8f74484c4e))
* **evidence:** persist typed workflow evidence linkage ([4e39e62](https://github.com/calvinnwq/momentum/commit/4e39e62a2e8405fdd866049c7217109a07a9ccaf))
* **evidence:** Surfaced typed runId/stepId evidence linkage through the evidence list and evidence ingest CLI output, completing the "list" surface of NGX-329's status/handoff/list scope. ([049de35](https://github.com/calvinnwq/momentum/commit/049de35e84cf8b6fe51ac95025751849978fdf90))
* **evidence:** Surfaced typed runId/stepId evidence pointers through workflow status and workflow handoff by querying the durable evidence_records.run_id linkage (with a path fallback for legacy null-linkage rows) instead of path-only inference. ([58e4337](https://github.com/calvinnwq/momentum/commit/58e4337cafe302c25ad12ef347d5158fb4828c01))
* **executor:** add executor-loop persistence schema ([2e94b3f](https://github.com/calvinnwq/momentum/commit/2e94b3ff745b794fdd7e81749fce4a2e45cbda9a))
* **executor:** add executor-loop persistence spine ([3e2aee0](https://github.com/calvinnwq/momentum/commit/3e2aee0a28b5ada2537f0cdd01e2bfa0732b46d9))
* **executor:** add executor-loop reducer ([6a3650d](https://github.com/calvinnwq/momentum/commit/6a3650d52e4b8315384c8afe1bf0e7ea3abd1620))
* **executor:** add no-mistakes executor mirror ([d73652a](https://github.com/calvinnwq/momentum/commit/d73652a06fc5861c8dc7206e7c7f0c34ba805e4b))
* **executor:** Added the no-mistakes executor mirror's external-state reader (pure parser + IO wrapper) that turns untrusted raw external state into the typed NoMistakesExternalState snapshot the brain classifies, with 25 focused TDD tests; typecheck/build/git diff --check and all no-mistakes tests green. ([ccef9d6](https://github.com/calvinnwq/momentum/commit/ccef9d649a5825b5cbecdb6b4e71cd206622ed25))
* **executor:** Extended the no-mistakes executor pure brain with the invocation, round-start, and round-persistence projections (the orchestrator-twin prerequisites) via 16 focused TDD tests, with all repo verification gates green. ([20d2d42](https://github.com/calvinnwq/momentum/commit/20d2d420252f3dc5e7ee85a8df0ca0d43ffe7ce6))
* **executor:** Landed the no-mistakes executor mirror's polling orchestrator (runNoMistakesMirrorRound/runNoMistakesMirrorStep) — the final NGX-351 module wiring the external-state reader → brain → real executor-loop persistence — plus two pure brain helpers and the family's internal-doc closeout, with 35 focused TDD tests and all repo verification gates green (2880 passed). ([2bf131c](https://github.com/calvinnwq/momentum/commit/2bf131ce531aa288a6d3e6beedcabdba5abb09f0))
* **executor:** Landed the pure no-mistakes executor mirror brain (decision/classification + findings/decisions projections + identity) for NGX-351 with 34 focused TDD tests, all repo verification gates green. ([51b5334](https://github.com/calvinnwq/momentum/commit/51b53340f3a14cb676266d9642bc273ad5b80208))
* **executor:** persist executor round evidence ([6b8af52](https://github.com/calvinnwq/momentum/commit/6b8af52652aa5845f5858b90c1da0f5806a82be5))
* **gate:** Landed the first M10-08 slice: a pure workflow-gate decision domain module (gate-type & target-scope vocabularies plus the delegated-policy/operator `evaluateGateDecision` brain) with 19 focused TDD tests, all verification gates green. ([3f9c81b](https://github.com/calvinnwq/momentum/commit/3f9c81b1567ea17f8406b5be59fc6ec42a4f9036))
* **gate:** Landed the M10-08 durable-gate persistence twin: a workflow_gates table plus workflow-gate-persist.ts wiring iteration 1's evaluateGateDecision brain to storage (insert/load/list/open-list/race-safe resolve with scope-ancestry validation and four typed errors), backed by 20 focused TDD tests with all verification gates green. ([0715db5](https://github.com/calvinnwq/momentum/commit/0715db5a9dc3686c384394d46c8a84c2f448c159))
* **gate:** Landed the M10-08 operator decision CLI: a `momentum workflow run decide <gate-id>` command that resolves durable workflow/step/executor gates through iterations 1-2's evaluateGateDecision brain (operator + delegated-policy paths), backed by 12 focused CLI decision tests with all four authoritative verification gates green. ([f2cd222](https://github.com/calvinnwq/momentum/commit/f2cd2222436d0ba761f3892f541fe44b6b8b319a))
* **gate:** Surfaced durable workflow gates in the `workflow run monitor` recovery envelope (JSON + text + open/total counts), completing NGX-352's gate visibility across all three read-only inspection surfaces, with two focused TDD visibility tests and all authoritative verification gates green. ([fd8987e](https://github.com/calvinnwq/momentum/commit/fd8987e9affc9ff89f09be63004f102945f89f8c))
* **gate:** Surfaced durable workflow gates in the `workflow status` and `workflow handoff` envelopes (JSON + text) via the shared run-detail loader, with two focused TDD visibility tests and all authoritative verification gates green. ([677cc5a](https://github.com/calvinnwq/momentum/commit/677cc5a4b67846bad6efe5065c461ec4f207fa1b))
* **goal-loop:** add goal-loop executor adapter ([f98d6a9](https://github.com/calvinnwq/momentum/commit/f98d6a93d9dd2949b3beb111a0998380f9f855f9))
* **goal-loop:** add goal-loop executor adapter ([7f6a415](https://github.com/calvinnwq/momentum/commit/7f6a415a51ceec07b80144656ccb98be5f9f9b3a))
* **scheduler:** add atomic dispatch-lease claim ([0749438](https://github.com/calvinnwq/momentum/commit/07494383eff6563205bac365be0749ef25460767))
* **scheduler:** add durable runnable workflow-work scan ([eac4d0a](https://github.com/calvinnwq/momentum/commit/eac4d0ac6359a98ab56964077ade8abe71561f59))
* **scheduler:** add stale workflow-lease recovery ([853baab](https://github.com/calvinnwq/momentum/commit/853baab234f9999e24da2ec3f7147d21c89b7f3b))
* **scheduler:** add workflow scheduler-lane tick ([04d6ea6](https://github.com/calvinnwq/momentum/commit/04d6ea67909e55c0ab310f3a3727d1fe6b5534e5))
* **scheduler:** wire workflow scheduler lane into daemon loop ([97cb9b7](https://github.com/calvinnwq/momentum/commit/97cb9b73d307f3fa23c23447c18def6420f11b82))
* **single-shot:** Added the pure single-shot round artifacts projection (planSingleShotRoundArtifacts) for NGX-350's one-shot/script executor adapters, with 8 focused TDD tests; pnpm test (2697), typecheck, build, and git diff --check all pass. ([71fab43](https://github.com/calvinnwq/momentum/commit/71fab432d7cbd357a0f417e30a50ae7c1235a3c4))
* **single-shot:** Added the pure single-shot round checkpoints projection (planSingleShotRoundCheckpoints) for NGX-350's one-shot/script executor adapters, with 4 focused TDD tests; pnpm test (2701), typecheck, build, and git diff --check all pass. ([199bffe](https://github.com/calvinnwq/momentum/commit/199bffe309f286e5fddccf45d39a9b94d93d39af))
* **single-shot:** Added the pure single-shot round persistence projection (planSingleShotRoundPersistence) composing decideSingleShotInvocation into capture/terminal round patches, with 10 focused TDD tests (6 pure + 4 DB round-trip); pnpm test (2711), typecheck, build, and git diff --check all pass. ([8c3f4f8](https://github.com/calvinnwq/momentum/commit/8c3f4f83a8438f9a83e2e7f3d6a1f86211a551d9))
* **single-shot:** Added the pure single-shot round selection resolver (resolveSingleShotRoundSelection) with deterministic per-field precedence and source tracking, via 11 focused TDD tests; pnpm test (2689), typecheck, build, and git diff --check all pass. ([abeb0e6](https://github.com/calvinnwq/momentum/commit/abeb0e65acebf7ad1d140b7c013ca45d67d482ee))
* **single-shot:** Added the pure single-shot round-start projection layer (planSingleShotRoundStart + planSingleShotRoundStartForInvocation) for NGX-350's one-shot/script executor adapters, with 6 focused TDD tests; pnpm test (2678), typecheck, build, and git diff --check all pass. ([cae02af](https://github.com/calvinnwq/momentum/commit/cae02af4e43d5f8c562ac756dcb5d5f02d83dbbe))
* **single-shot:** Added the single-shot executor orchestrator (runSingleShotRound + runSingleShotStep) driving one round through the real executor-loop persistence layer around an injected mechanism, with 13 focused TDD tests; extended internal/smoke-tests.md and internal/milestones/m10-workflow-first-runtime.md to cover M10-06; pnpm test (2711 + my 13 = 2724), typecheck, build, and git diff --check all pass. ([f6632fe](https://github.com/calvinnwq/momentum/commit/f6632fe5abd59a0c778166d541de177c96e936bb))
* **single-shot:** Landed the pure single-shot executor decision layer (recovery taxonomy, classification, deterministic identity) shared by the one-shot and script families, with 27 focused TDD tests; all available verification gates pass. ([bcab0f2](https://github.com/calvinnwq/momentum/commit/bcab0f21004aed03b57e5a627e90291cddf5170b))
* **workflow run list:** Landed NGX-324 (M8-01 workflow run list and query surface). Extended the M7 listWorkflowRunSummaries helper with --approval-boundary, --repo, --issue-scope (LIKE with escape), --updated-since, and --updated-until filters; added the workflow run subcommand dispatcher and the read-only workflow run list CLI envelope with stable JSON ({ ok, command: "workflow run list", count, runs[] }) and bounded text output. Refusal codes (invalid_filter, invalid_state, invalid_limit) reuse the M7 taxonomy verbatim; empty result is a successful empty list, not a refusal. Verification: pnpm test 1813/1813, pnpm typecheck clean, pnpm build clean. (pnpm lint and pnpm format:check are not defined in this repo; only test/typecheck/build are gates per CLAUDE.md.) Doctor M7 closeout marker untouched per the M8 closeout policy. Issue moved to In Progress in Linear; not marked Done. ([d00cdb8](https://github.com/calvinnwq/momentum/commit/d00cdb8da6abf61e68b4d15d4f6f09a0f0c857be))
* **workflow-monitor-state:** pure deriveWorkflowMonitorState reducer with active-step, lease-freshness, monitor-drift, nextAction, and recovery taxonomy (NGX-316) ([10fc99c](https://github.com/calvinnwq/momentum/commit/10fc99c0f9e05e5e84f44c37edb4059b98937cb2))
* **workflow-run-import:** parse, persist, and import .agent-workflows run directories ([9183750](https://github.com/calvinnwq/momentum/commit/918375028acb5d6be656b3380be5b9c3448b8627))
* **workflow-run:** add classifyWorkflowLease lease-freshness classifier ([d815637](https://github.com/calvinnwq/momentum/commit/d8156371a380321e16710122d91a5527660c5a45))
* **workflow-run:** add workflow_runs/steps/approvals/leases schema migration ([097a059](https://github.com/calvinnwq/momentum/commit/097a0591b4262774ed0fe4b0efe3a78bdb7bb5f9))
* **workflow-run:** add WorkflowRun identity columns to schema ([1ee0d8b](https://github.com/calvinnwq/momentum/commit/1ee0d8bea90af872ea07ac6c304723db01c8a1b6))
* **workflow-run:** add WorkflowRun substrate schema and state reducer ([90ee9f0](https://github.com/calvinnwq/momentum/commit/90ee9f0fa0dc125ea54668b4510732f2172a91e3))
* **workflow-run:** add WorkflowRun/WorkflowStep state model and transition reducer ([8bf3130](https://github.com/calvinnwq/momentum/commit/8bf31305314994913381415c30e8e5d068bc6543))
* **workflow-run:** integrate workflow_leases into deriveWorkflowRunState ([5e76fdf](https://github.com/calvinnwq/momentum/commit/5e76fdf67f5ac1224a16ec4a70e54cc9eeac771b))
* **workflow-step-executor:** Landed the WorkflowStepExecutor boundary (NGX-315): typed input/result/checkpoint/artifact shapes, registry keyed by WorkflowStepKind, stable error code taxonomy, deterministic fake executors per kind, focused tests pumping a full required-step chain through the M7 state machine, and matching internal M7 docs. ([ce4d958](https://github.com/calvinnwq/momentum/commit/ce4d9588eace0c8a1b8f309c00439135c8ec34b2))
* **workflow:** add `workflow run start` CLI command ([471f993](https://github.com/calvinnwq/momentum/commit/471f9939f92941860e32c43ed2449f1e82ce4343))
* **workflow:** add dogfood terminalize-and-continue dispatch fixture and opt-in daemon-start seam (NGX-391) ([0deedc3](https://github.com/calvinnwq/momentum/commit/0deedc3fb571f6d08607feed65c0db05f733cd1c))
* **workflow:** add durable workflow gates and the run decide decision CLI ([af22d7a](https://github.com/calvinnwq/momentum/commit/af22d7afe34933977ee5a0bd7069e4d681e0c297))
* **workflow:** add durable workflow run approvals ([5e4a89b](https://github.com/calvinnwq/momentum/commit/5e4a89bfe195ac8bb014f79167a434134978a8c5))
* **workflow:** add durable workflow run approvals ([9b2365f](https://github.com/calvinnwq/momentum/commit/9b2365fafb350a30472b7d1d0ad22c338ae92bb9))
* **workflow:** add live step execution orchestration ([bd7a93e](https://github.com/calvinnwq/momentum/commit/bd7a93e4542825bec1f7290b7d07b9ca17f141ab))
* **workflow:** add live step execution orchestration ([f2b79f1](https://github.com/calvinnwq/momentum/commit/f2b79f178f35b036bdd67f22e460ca94737576e2))
* **workflow:** add live wrapper registry ([0cbdda6](https://github.com/calvinnwq/momentum/commit/0cbdda6ad75f40083c5fd9ac321cb0a547fc2a87))
* **workflow:** add opt-in dogfood terminalize-and-continue daemon dispatch fixture ([1892963](https://github.com/calvinnwq/momentum/commit/189296379c323f3d35d0986b6eaec559c74f7c2d))
* **workflow:** add read-only status and handoff CLI envelopes ([a14a67a](https://github.com/calvinnwq/momentum/commit/a14a67acf1de96fce3748adfaf9e38537a976f12))
* **workflow:** add read-only workflow status and handoff CLI envelopes (NGX-317) ([477235c](https://github.com/calvinnwq/momentum/commit/477235c544d53a55a0c144900027c9db51b62db5))
* **workflow:** add workflow run list command with query filters ([016eaa4](https://github.com/calvinnwq/momentum/commit/016eaa409d8f97e8bd04f0edb2bf85a3bc163143))
* **workflow:** add workflow run monitor envelope ([9b40e3d](https://github.com/calvinnwq/momentum/commit/9b40e3dbc238f9f720726e0942c33da9f28321eb))
* **workflow:** add workflow run update-step operator transition surface ([8296e66](https://github.com/calvinnwq/momentum/commit/8296e661e6db65a684f4a04966c247b2224b7bbf))
* **workflow:** add workflow run update-step operator transition surface ([c406148](https://github.com/calvinnwq/momentum/commit/c4061486c3bf5188eb0d71694e2d5915ddcbf1ea))
* **workflow:** add workflow run-start materialization core ([7298347](https://github.com/calvinnwq/momentum/commit/7298347e87a8af67c7f82b519a3c36bdc31b7bb8))
* **workflow:** add WorkflowDefinition/StepDefinition domain core (NGX-345) ([d2b7330](https://github.com/calvinnwq/momentum/commit/d2b7330f743366e75eb474df3506270d085cad1b))
* **workflow:** Added advanceLiveWorkflowStep, the M9-03 run-level composition that wires the live-step orchestrator, finalize transaction, and durable recovery into one managed-step advance, completing NGX-334 end-to-end with 7 focused TDD tests. ([37f2667](https://github.com/calvinnwq/momentum/commit/37f2667f50e44e9859685122b95989650103c44f))
* **workflow:** Added finalizeLiveWorkflowStepFromResultFile, the M9-03 seam that reads a live step's normalized runner-result document and drives the verify→commit/reset transaction with head-mismatch and result-document recovery, covered by 9 new TDD tests. ([8dc8a3a](https://github.com/calvinnwq/momentum/commit/8dc8a3ad942b5f90490188d92ecf0dd95b6260f6))
* **workflow:** Added persistLiveWorkflowFinalizeRecovery, the M9-03 run-level seam that durably enters manual recovery (needs_manual_recovery flag + recovery.md) from a live finalize-from-result-file outcome, plus a renderer extension for the M9 live recovery codes, covered by 12 new TDD tests. ([92d8ee4](https://github.com/calvinnwq/momentum/commit/92d8ee417279037332de549c0141047faf382185))
* **workflow:** Added the auto-set reconciliation (reconcileWorkflowRunManualRecovery) for NGX-327 — the monitor→setter trigger that durably flags a run and renders recovery.md when the M7 monitor reducer classifies a blocking recovery code — with 10 TDD tests and all runnable verification gates green. ([861b0e2](https://github.com/calvinnwq/momentum/commit/861b0e283929fc03f79561be12c3be9b82861b9b))
* **workflow:** Added the durable run-scoped manual-recovery flag DB module (mark/clear/get-state) for NGX-327, mirroring the M3 goal-recovery pattern, with 11 focused TDD tests and all available verification gates green. ([59af489](https://github.com/calvinnwq/momentum/commit/59af48922007b7fa36ecc75e3e46269ed5e4182b))
* **workflow:** Added the guarded operator clear for NGX-327 that re-derives the M7 monitor state and refuses with recovery_clear_refused while a blocking recovery condition persists, with 8 TDD tests and all runnable verification gates green. ([8452c55](https://github.com/calvinnwq/momentum/commit/8452c55e057537441634d547390c888ba9edc40b))
* **workflow:** Added the operator-facing `workflow run clear-recovery` CLI subcommand for NGX-327, wiring the guarded manual-recovery clear into the dispatcher with full refusal taxonomy, docs, and 7 TDD tests; all runnable verification gates green. ([4fea5a2](https://github.com/calvinnwq/momentum/commit/4fea5a2d0a5001495a6212447a5c23201eabd693))
* **workflow:** close out M8 operator controls ([18318b8](https://github.com/calvinnwq/momentum/commit/18318b8a9e81ab8d84eb2508b734956972ffc4ed))
* **workflow:** Implemented NGX-328 (M8-05): the read-only `workflow run monitor` CLI machine envelope deriving a stable report/wait/recover decision view from durable rows and the M7 monitor reducer, with focused unit + built-CLI tests. ([9283021](https://github.com/calvinnwq/momentum/commit/92830211f766d978ba1d65f37dad500549fec03c))
* **workflow:** Implemented NGX-332 (M9-01): a typed live-wrapper config parser plus a WorkflowStepKind-keyed registry with resolution, probe support, and stable refusal codes, covered by 45 deterministic fixture tests. ([a9a5550](https://github.com/calvinnwq/momentum/commit/a9a55508e3e5efa46b256c6b6f5c73a35081269a))
* **workflow:** Implemented the core M9-03 primitive finalizeLiveWorkflowStep, wiring a live workflow step's output into Momentum's verification + commit/reset transaction with head-mismatch manual recovery, covered by 8 focused tests. ([6c5aa91](https://github.com/calvinnwq/momentum/commit/6c5aa91f85137481b943fea3becc9fa7b106695a))
* **workflow:** Implemented the foundational run-scoped recovery.md renderer for NGX-327 (M8-04) — a pure, fully-tested module that renders the per-run recovery artifact from the M7 monitor reducer's recovery taxonomy — with all available verification gates green. ([1c6d12c](https://github.com/calvinnwq/momentum/commit/1c6d12ced6c4d6f36f232410f5dc981ccca1c8c7))
* **workflow:** import .agent-workflows run directories ([39b779a](https://github.com/calvinnwq/momentum/commit/39b779a0612820ddc155b1f75ee5dd3bfd055095))
* **workflow:** persist workflow run start to durable tables ([d9f1228](https://github.com/calvinnwq/momentum/commit/d9f1228bcb3e6d144811c1c7e3b1edf510375a13))
* **workflow:** persist workflow/step definitions durably (NGX-345) ([03c2833](https://github.com/calvinnwq/momentum/commit/03c2833f37a4da145586471117d80dfb7aaf3313))
* **workflow:** Wired the run-scoped manual-recovery auto-set into the reachable `workflow import` path for NGX-327 — import now durably flags a run and renders recovery.md when a blocking M7 monitor recovery code is re-derived — and added CLI smoke for blocked/cleared states; all runnable verification gates green. ([7f7b735](https://github.com/calvinnwq/momentum/commit/7f7b735efadebe765247cd8a58060d5001322939))


### Bug Fixes

* **cli:** preserve output contracts behind renderer boundaries ([cff4f88](https://github.com/calvinnwq/momentum/commit/cff4f881efcf22add631ab9f38524189763162d4))
* close renderer and adapter boundary gaps ([4688d4f](https://github.com/calvinnwq/momentum/commit/4688d4fd799e49eb1473df623de839837e3423c1))
* complete adapter ownership coverage ([d6b70fd](https://github.com/calvinnwq/momentum/commit/d6b70fd5a6ed2121f2a16a594cd648b8e8bf7146))
* complete renderer boundary extraction ([8275e47](https://github.com/calvinnwq/momentum/commit/8275e4773256ee601ce879fe419ec7db76c9b6a5))
* **executor:** guard executor state updates against stale writes ([273f949](https://github.com/calvinnwq/momentum/commit/273f9497a865ea27ea44a54ede396bac0860ec10))
* finish renderer delegation gaps ([7c98f62](https://github.com/calvinnwq/momentum/commit/7c98f62e01985b3ff577705e8b5bed7619bf04bc))
* harden isolated workflow adapter contracts ([5848f50](https://github.com/calvinnwq/momentum/commit/5848f50e2fd94329975bfa81dcce424377d8761a))
* **live-step:** keep repo lock heartbeats monotonic ([4f9cd63](https://github.com/calvinnwq/momentum/commit/4f9cd639352048f095f50eda12fd6b3f1e8827cb))
* **workflow-monitor-state:** emit monitor_drift_stale recovery code, add drift/stale/checkpoint-default tests, simplify graceMs pass-through (NGX-316) ([c011c09](https://github.com/calvinnwq/momentum/commit/c011c09edb649c68f17648fcb1703bc40cf78fae))
* **workflow-step-executor:** tighten errorCode type to stable taxonomy, add config validation tests, update contract doc for env field (NGX-315) ([63cb2b4](https://github.com/calvinnwq/momentum/commit/63cb2b43fb4b3c005b62695469c0fb825b13ee33))
* **workflow:** add invalid_limit refusal code, update README with status/handoff commands (NGX-317) ([3c33793](https://github.com/calvinnwq/momentum/commit/3c337930750d3688dc2c0fa40d0fd842a45032cf))
* **workflow:** align live wrapper config parsing ([835b80d](https://github.com/calvinnwq/momentum/commit/835b80dba2fd7b93906a95cc5fd9f7a9273273e4))
* **workflow:** clarify running step lease evidence ([2008354](https://github.com/calvinnwq/momentum/commit/2008354f5be9ea225d2153c713522a0938dc6a16))
* **workflow:** clarify running-step resume evidence in monitor next-action ([1b1c59e](https://github.com/calvinnwq/momentum/commit/1b1c59ebf6c53aab9ca0251989a3c9f4897a8884))
* **workflow:** close M10 dogfood dispatch state ([955f776](https://github.com/calvinnwq/momentum/commit/955f776eb5a8b9b27b15619be86825da9191405c))
* **workflow:** close M10 dogfood dispatch state ([6a603af](https://github.com/calvinnwq/momentum/commit/6a603af56e7abe36a34ce209f27b16056e0a0ebc))
* **workflow:** handle monitor database failures ([d84a479](https://github.com/calvinnwq/momentum/commit/d84a479e918cec69d6214c2c0260be8f42bf704b))
* **workflow:** harden operator step transitions ([8668502](https://github.com/calvinnwq/momentum/commit/86685024f46665168ae3bed29b3e6a1e41fe5c5f))
* **workflow:** persist run-start approval coverage ([fb86f3d](https://github.com/calvinnwq/momentum/commit/fb86f3d7ce3be98ab948f1d6b96bf84a0624539f))
* **workflow:** refresh monitor advisory on recovery controls ([4d505ef](https://github.com/calvinnwq/momentum/commit/4d505ef7ef06c83041076170635712caa597206c))
* **workflow:** refresh monitor advisory on step update ([8c98ef1](https://github.com/calvinnwq/momentum/commit/8c98ef16747fc124ea647b898cd3c4c38887dbf1))
* **workflow:** refuse non-approved live step starts ([57215b2](https://github.com/calvinnwq/momentum/commit/57215b218816758cf0c86ea4b6536789d7922326))
* **workflow:** require explicit live wrapper fields ([6e0a2b7](https://github.com/calvinnwq/momentum/commit/6e0a2b7298a4fb43f7d987adf1eee951103a9d4a))
