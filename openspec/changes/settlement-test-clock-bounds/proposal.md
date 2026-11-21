# Settlement test clock bounds

## Why

`platform/test/browser-driver-settlement.integration.test.ts:99` (`elapsed >= 400`) and `:133` (`elapsed >= 300`) compare the parent's `performance.now()` stopwatch, started only after an uncontrolled preparation (stdout wait, `identity()` — a blocking `spawnSync` Python on darwin — and `writeReceipt`), against a `setTimeout` in the child process. Under load the preparation exceeds the 200 ms margin or the child timer fires a few ms early, so a correct helper reads 397.69 and `pnpm check` fails intermittently and unattributably (macOS, load ~40). `awaitRegisteredDrivers` (`scripts/probe-browser-runtime.mjs:314-320`) promises no minimum wait; "the helper waited" is already proven by state: `:101` (driver exited or zombie on return) and `:135` (pointer `stopped`). Introduced in `5181eb8` (#579). Issue #653.

## What Changes

- Remove the two cross-process lower bounds (`:99`, `:133`). Keep the state assertions (`:101`, `:135`), the upper bounds (`< 5_000` and the others) and the same-clock `>= 800` lower bounds at `:147` and `:240`.
- Spec: state the helper's settlement contract — which registrations hold the wait, what settles them, and that `settled: false` comes no earlier than the helper's own-clock limit with no minimum wait — so the proof obligation is behavioral, not a timing proxy. The existing immediate-return cases (`:158-208`) are its second scenario.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent
Blast radius: removing a bound that was the only proof of waiting would let an early-returning helper pass; the retained state assertions are that proof
Selected risk packs: none
Evidence floor: mutant run showing an early-returning helper still fails the two cases; the file repeated under load; pnpm check; exact-head VPS lane (platform/test change)
```

`design.md` is omitted (level compact).

## Capabilities

### Modified Capabilities

- `browser-runtime-verification`: adds the registered-driver settlement contract.

## Impact

`platform/test/browser-driver-settlement.integration.test.ts` only. No product code.
