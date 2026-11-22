# Trusted Docker oracle strength

## Why

Issue #658: two trusted-Docker integration oracles stay green under their own counterexamples. Line numbers are on main `6871d6c`. The retirement and custody tests and the scripts keep the issue's `be168db` lines; `trusted-docker-fixture.ts` moved, because #656 inserted 35 lines.

- **(1) Retirement scene.** `trusted-docker-retirement.integration.test.ts:343` matches `owner\.log tail` and `owner process tree` with no `:\n`, so `… unavailable` also passes. `piece` returns that string when its reader throws (`:77`). Here the owner is already dead, so even a successful tree is empty. No case ever sees a real tree line from `retirementScene` (`:71-91`, used only at `:131` and `:339`).
  - (1) is test diagnostics only. No spec describes the result-wait scene, so it has no spec delta.
- **(2) Post-close member.** `trusted-docker-custody.integration.test.ts:758-772` asserts `settled: true`, the `memberTiming` format and `exited - vanished >= 300`. `vanished` is when the command was reaped, not when the owner saw `close` (`scripts/trusted-docker-owner.mjs:346-359`).
  - If close is delayed past the member's exit, the owner's first `groupIsAbsent` poll (`trusted-docker-record.mjs:182-198`) finds the group gone. The case stays green, but the product path it guards never runs. That path is a member still present at close that exits within the 2000 ms window. This is the #630 regression class.

## What Changes

- **(1A)** `:343` requires the success forms `invocation files:\n`, `owner\.log tail:\n` and `owner process tree:\n`, with `owner process tree:\n` at the end of the message. The owner is dead, so its tree is empty. The negative check is limited to `/(invocation files|owner\.log tail|owner process tree) unavailable/`. The message also carries `identity recheck unavailable` (`trusted-docker-fixture.ts:113`) and an uncontrolled owner.log tail, so a message-wide `unavailable` ban would flake.
- **(1B)** A positive tree case on a live root with a known child. It asserts at least one line whose first column is the root pid, and at least one line whose ppid is the root pid. `retirementScene` and the new case share one walk.
- **(2)** The existing owner-side preload (`trusted-docker-fixture.ts:265-303`) is extended to the `post-close-member` mode.
  - The mode switches from the real `verify:docker` script string (`package.json:38`, read at `fixture.ts:279`) to `node --import ./fixture-preload.mjs …`.
  - Counting and the receipt run only when `process.argv.includes('own')`, following the slow-owner pattern at `fixture.ts:295`.
  - The preload passes `kill`'s return value and exceptions through unchanged. This mode denies nothing.
  - It wraps the existing `childProcess.spawn` hook (`fixture.ts:289-294`). It identifies the command child exactly as `command === 'pnpm' && args[0] === 'test:docker'` (`FULL_DOCKER_COMMAND`, `trusted-docker-record.mjs:15`; the rebound `spawn` also starts the Linux producer observer and probes). On that child it registers `once('close')`, before `owner.mjs:346` registers its own handler, and records `closedAt` and the match count, which must be exactly 1.
  - It counts negative-pid, signal-0 `process.kill` calls, and records:
    - `firstObservedAt`, the first call after close, and `firstPresent`, whether that call returned without error;
    - `presentPolls`, calls that returned without throwing; EPERM is a possibly-dead Darwin zombie and is not counted as present;
    - `preClosePolls`.
  - Each update is written synchronously (`writeFileSync(.pending)` + `renameSync`) to a receipt under the gitignored `.run/` (`fixture.ts:312`). It never goes in the fixture repository root, which `requireReviewedCheckout` rejects (`record.mjs:116-127`, `owner.mjs:459`).
  - The case asserts:
    - `preClosePolls === 0` and `closedAt <= firstObservedAt`. This is the premise lock: the first such call comes from `groupSettlesAfterClose`.
    - `firstPresent === true` and `presentPolls >= 1`.
    - `memberExit.exited > firstObservedAt`.
    - the existing `settled: true`.
  - A missing or partial receipt fails explicitly. The reader and these assertions live in one helper in the new `-fixture.ts` (for example `expectMemberOutlivedClose`), so the custody test gains one call. `memberTiming` may add the close time.
- No product change: `scripts/trusted-docker-*.mjs` are untouched. Nothing is lengthened or retried, and no existing assertion is removed.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: trusted-docker custody and retirement integration tests; a wrong preload premise or receipt race makes post-close-member flaky; custody test and trusted-docker-fixture.ts are near their 800 effective-line limits and prepareCustodyRepository near the 200-line function limit; the Linux ps behaviour of the tree walk is unverified
Selected risk packs: Concurrency / shared state / ordering (close vs member exit vs group polls); Error handling / rollback / partial outputs (receipt atomicity, unavailable pieces); File IO / path safety / overwrite (cross-process receipt under .run/)
Evidence floor: AC mutants as fixed in tasks 1.3 (green before / red after where stated); both files green three times locally; pnpm check; exact-head CI layer3-integration green (Linux runs these files); exact-head VPS lane (repository gate)
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: the command-settlement regression proves that the member outlived close.

## Impact

- `platform/test/trusted-docker-retirement.integration.test.ts`
- `platform/test/trusted-docker-custody.integration.test.ts`
- `platform/test/trusted-docker-fixture.ts`: the preload template
- a new `platform/test/trusted-docker-*-fixture.ts` for the receipt reader and any extracted walk, if the size limits require it. The `-fixture.ts` suffix is required; other `trusted-docker-*.ts` files are copied into each fixture repository (`fixture.ts:250-257`).
