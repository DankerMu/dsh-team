# Claim a finished uncaptured command and wait for the uncaptured launch receipt

## Why

Issue #718, items 1–3. Item 4, splitting the fixture, landed in #726. Line numbers are from main `85a325f`.

1. **Finished owner without `child.json`.** The identity wait can expire before the owner writes `result.json`, and the owner can then exit without ever writing `child.json`.
   - `boundCommand` (`platform/test/trusted-docker-uncaptured-fixture.ts:158-165`) never reads `result.json`, so it throws `UnidentifiedCommand('owner gone without receipt')`.
   - `claimUncaptured` (`:205-208`) then returns no authority. The fixture (`trusted-docker-fixture.ts:449-466`) adds `Uncaptured custody fixture authority retained: … owner gone without receipt` and leaves the owner's temporary root (`/tmp/dsh-team-docker-XXXXXX`) in place, because only `:476-487` deletes it.
   - The case has already failed, so it now reports two failures and leaks a root.
2. **Leaks.**
   - Counted read-only on the dev machine: 7 `/tmp/dsh-team-docker-*` (11-22 to 11-24) and 18 `$TMPDIR/dsh-team-custody-audit-*`.
   - Possible sources, inferred from the code and not attributed:
     - the case above;
     - `start` killed between `mkdtemp` (`scripts/trusted-docker-owner.mjs:96`) and `request.json`;
     - a failed settle;
     - a killed worker, which never runs `finally` (audit `trusted-docker-audit-fixture.ts:206-208`).
   - Vitest has no `globalSetup` for integration. The docker root's prefix carries no run id, so a safe sweep would need ownership proof.
3. **Unwaited reads in the first uncaptured case.** `trusted-docker-uncaptured-fixture.integration.test.ts:41-58` reads `readdirSync(base)[0]` and `launch.json` right after `start` is killed. `start` writes `launch.json` only after it spawns the owner (`:137`), so under load the case can fail with `ENOENT` instead of its assertion. That is the same race as #687 row 8. The case also polls inline and reimplements `ownerOf` instead of using the exported `waitFor` and `ownerOf` (`trusted-docker-uncaptured-fixture.ts:46-55`).

## What Changes

See design.md for ordering, seams and evidence.

- **#1.**
  - When the owner is confirmed gone and no `child.json` exists, `boundCommand` reads `result.json` and `manifest.json` (mode 0600) and validates them with the exported `validateTerminal` for this invocation.
  - A settled command returns a distinct `finished` outcome, reported as `command finished`. The fixture's uncaptured branch then hands back the authority, deletes the temporary root, and pushes no "authority retained" failure for that outcome only.
  - Anything else keeps today's exact retained outcome.
- **#3.**
  - The first case waits for the invocation directory and `launch.json` through the exported `waitFor`, and reads the owner pid with `ownerOf`.
  - A test-only start delay in the preload, placed before `launch.json`, makes the case run with and without the delay through `it.each`.
- **#2.** No sweep. Diff the leak names around one green full run on a quiet machine. A non-empty diff keeps #718 open.

## Triage

```text
Issue type: test-infrastructure bugfix
Fixture level: expanded (temporary-root deletion and receipt ordering are expanded triggers)
Upstream suggested level: absent
Blast radius: platform/test uncaptured custody fixture, its cleanup branch and preload, its integration test; authority hand-back and root deletion for one more terminal shape; no product code, no scripts/ change
Selected risk packs: Error handling; Resources (process groups, temp roots); Concurrency/ordering (receipt order, launch race)
Evidence floor: stub rows (settled, unsettled, wrong digest, wrong invocation, unreadable, missing, receipt-wins), one real-owner late-finish case, the delayed-start it.each row, a name-list leak diff around a green full pnpm test:integration, exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: an owner that is already gone, whose validated `result.json` records a settled command, is claimed as a finished command. Both uncaptured-cleanup requirements are amended consistently.
  - Two existing SHALL wordings are rewritten, because the new exception would otherwise contradict them:
    - In "Identification is uncertain", the WHEN clause "no receipt exists" becomes "neither a command receipt nor a valid settled `result.json` exists".
    - The sentence "A captured start that ends with `result.json` and no command SHALL keep its current handling" is narrowed to a start "whose identity wait itself ends on `result.json`".

## Impact

- `platform/test/trusted-docker-uncaptured-fixture.ts`
- `platform/test/trusted-docker-fixture.ts`: the uncaptured branch `:449-466` and the preload hooks
- `platform/test/trusted-docker-uncaptured-fixture.integration.test.ts`
- No `scripts/` change
