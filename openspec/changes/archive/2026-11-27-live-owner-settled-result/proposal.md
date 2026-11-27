# A live owner with a settled result and no receipt is claimed as a finished command

## Why

Issue #740, recorded as out of scope during the #718 review (PR #732). Line numbers refer to main `46c07e9`.

The same disk state is claimed differently depending on whether the owner has already exited. The state: `result.json` validated and settled, no `child.json`.

| Owner  | Path in `boundCommand` (`platform/test/trusted-docker-uncaptured-fixture.ts:195-212`) | Report               | Caller (`trusted-docker-fixture.ts:491-492`)                             |
| ------ | ------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| exited | not frozen → no receipt → `settledResult` → `{ finished: true }`                      | `command finished`   | no failure                                                               |
| alive  | frozen → `scannedCommand` → `none` → `{ child: undefined }`; `result.json` never read | `no command started` | adds `Uncaptured custody fixture authority retained: no command started` |

- **Window.** The owner writes `result.json` (`scripts/trusted-docker-owner.mjs:464`), then returns and exits. A cleanup that claims inside that window takes the second row. This is inferred from the code and was not reproduced.
- **Why the label is wrong.** `trusted-docker-owner.mjs:322` initializes `command` as settled before spawn. A settled result without `child.json` therefore has three sources: a launch failure, an interrupt before spawn, or a spawn followed by a failed `child.json` write (`:372-384`, `failure = 'identity'`). In the third case the command did run, so `no command started` is wrong. In all three, the exited-owner path says `command finished`.
- **Impact.** No leak: the authority is still handed back and the root deleted. The cost is a spurious failure line and a misleading label.
- **Coverage.** No test covers this path. The `claims an uncaptured owner` table's `result` rows are all `live: [false]`. `lateFinish` deliberately waits for the owner to exit first.

## What Changes

The issue's recommended option.

- **`boundCommand`, stopped owner.** It still scans first, so a live command stays bound as `command <pid>`. Only a clean `none` scan result (`scannedCommand` returned `undefined`) reads `settledResult(root, invocation)`. Every uncertain scan outcome (scan failed, owner unlisted, ambiguous child, an in-flight child past its wait, an unobservable command) stays `command unidentified (…)` with the authority retained, whatever `result.json` says:
  - validated and settled → `{ finished: true }`;
  - missing, unreadable, invalid or unsettled → `{ child: undefined }` (`no command started`, unchanged).
- **`claimUncaptured`** keeps its mapping: `finished` → `command finished`, authority handed back, no "retained" failure. The event sequence for the new path is `SIGSTOP`, `ps stat`, `ps scan`, `settle`.
- **Unchanged:** the receipt path; the exited-owner path (#718); the owner's write order for `result.json` and `child.json`.

## Triage

```text
Issue type: test-infrastructure bugfix (custody cleanup labelling)
Fixture level: expanded
Upstream suggested level: absent (reads persisted result.json under a live, frozen owner; ordering against the owner's exit)
Blast radius: trusted Docker custody fixture cleanup reports in integration and VPS lanes; a wrong change could hand back authority for a live command
Selected risk packs: Concurrency / shared state / ordering; File IO (persisted result.json); Error handling; Legacy compatibility
Evidence floor: new claimUncaptured table rows (red before for the live+settled row); pnpm test:integration trusted-docker-uncaptured-fixture cases; pnpm lint (max-lines margin); exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: a live, frozen owner whose scan finds no command and whose validated `result.json` records a settled command is claimed as a finished command.

## Impact

- `platform/test/trusted-docker-uncaptured-fixture.ts` and `trusted-docker-uncaptured-fixture.integration.test.ts`.
