# Custody fixture: an unpublished command after a captured start is claimed like an uncaptured one

## Why

Issue #692. Line numbers refer to main `ae9fc70` plus #709. They are re-checked at implementation.

- **The captured start's command-identity wait.**
  - `captureStart` (`trusted-docker-fixture.ts:688-737`) records `{owner, temporary, device, inode}` into `issued` (`:720`), then polls for `child.json` or `result.json` under `budget.limit('command identity', 10_000)` (`:721-728`).
  - At expiry it throws `Command identity unpublished` (`:726`) and leaves the authority in `issued` **without** `child`.
- **Cleanup never revisits it.**
  - Cleanup (`:756-817`) claims only names **not** in `issued` (`:772`, through #661's `claimUncaptured`).
  - For issued authorities, it settles a command group only when `authority.child` exists (`:797`), and it never re-reads `child.json`.
  - The owner keeps running until `:799` kills it. A command it spawned before or after the timeout, or a `child.json` it writes after it, is therefore never retired. The detached `pnpm test:docker` group is orphaned, and cleanup reports nothing.
- **The #661 mechanism already handles exactly this state for uncaptured starts** (`trusted-docker-uncaptured-fixture.ts:171-209`):
  - freeze the owner;
  - bind the command from the `child.json` receipt, or, while the owner is stopped, from a scan of its children;
  - settle the owner on every path;
  - report `command <pid>`, `no command started` or `command unidentified (…)`.
- **Latent:** no case reaches this timeout today. The defect is inferred from the code path.

## What Changes

- **`issued` is set once, after the wait.**
  - `captureStart` no longer records the authority before its identity wait (`:720`). It records it once, after the loop: with `child` when `child.json` was read, and without it when the owner ended with `result.json` alone.
  - Any throw between capture and that point leaves the invocation out of `issued`, so cleanup's existing loop over names not in `issued` (`:772`) claims it with `claimUncaptured`. Such throws are the `Command identity unpublished` expiry (`:726`), the case deadline at `budget.limit` (`:722`), and an unreadable `child.json` (`:730`). The claim then:
    - freezes the owner;
    - binds the command from the `child.json` receipt, which may have been written late, or, while the owner is stopped, from a scan of its children;
    - settles the owner on every path;
    - lets the caller settle the bound command's group afterwards.
  - It reports `Uncaptured custody fixture authority retained: command <pid>` or `… no command started`, reusing #661's wording.
  - The cleanup comment at `:770-771` is updated: the claim covers a start killed at the deadline **and** a captured start whose identity was never recorded.
  - This adds no `max-lines` counted line. The file is at 799 of 800.
- **The two paths share one implementation, `claimUncaptured`.** There is no second freeze/bind/settle path (Code Canonicality).
- **A captured start that ends with `result.json` and no `child.json` stays in `issued`, as today.** That is an owner that never started a command, and a claim would misreport it as `owner gone without receipt`.
  - If the owner writes `result.json` and exits after the wait has expired but before cleanup, the claim reports `command unidentified (owner gone without receipt)` and retains the authority. The case has already failed by then. The claim then reports the retention loudly, never silently, which is acceptable.
- **Cases** go in `platform/test/trusted-docker-uncaptured-fixture.integration.test.ts`, next to #661's case. Both reuse the existing `unpublished-command` owner mode, with no new `CustodyMode`.
  - **(a) Spawned, never published.**
    - The case gives a fixture deadline wide enough for the start to succeed past the mode's 4 s pre-manifest hold, and short enough for the identity wait to expire inside the case. The CLI `start` waits for the owner's manifest up to 10 s (`waitForPublication`, `scripts/trusted-docker-owner.mjs:69-70`), so 4 s is inside it. The full arithmetic is stated:
      - the start, including the 4 s hold;
      - the identity wait up to the deadline;
      - the claim's 2 s stop confirmation;
      - the owner and group settles;
      - all strictly inside the case budget.
    - The case asserts the thrown `Command identity unpublished after …ms: pid=<owner>`. The fixture deadline is set so that the start reliably returns before it. Two other outcomes are load failures, not what this case proves:
      - `command identity: case deadline passed before it started` (`:722`, no pid);
      - `command start: killed at the case deadline`, which falls back to #661's path. The assertion level is stated: the inner error and the cleanup's `AggregateError` inside the fixture's outer `AggregateError('Custody scenario and cleanup failed')`.
    - The cleanup errors must hold `Uncaptured custody fixture authority retained: command <pid>`, with the pid read **inside the callback** from `publishedCommand`. Before the fix, cleanup removes the directory.
    - Afterwards the owner is absent, and `groupSettlesAfterClose(command)` is true.
    - Before the fix, the command group is still present after cleanup, and no report names it. That is the red.
  - **(b) A late `child.json`.**
    - `UNPUBLISHED_COMMAND_PRELOAD`'s fixed 30 s `Atomics.wait` (`trusted-docker-uncaptured-fixture.ts:26`) becomes sliced polling, up to the same 30 s, for a release file. The polling stays synchronous: an `Atomics.wait` slice, then `existsSync`, because the owner's event loop is blocked inside the `spawn` override.
      - The release file's path is a named constant beside `UNPUBLISHED_COMMAND`, under the fixture repository's gitignored `.run/`, resolved with `new URL(…, import.meta.url)`.
      - The test and the preload share that constant, and `existsSync` joins the preload's import.
    - Once released, the owner returns from its `spawn` override, and its normal flow writes `child.json`.
    - The case catches the expiry, writes the release file, and waits, bounded, for `child.json` before cleanup runs. The cleanup report names that command, and its group is absent afterwards.
    - #661's case never writes the release file, so it behaves as today.
  - **Budgets.** Each case's budget is a named constant with its ledger, of this order:
    - fixture deadline ≈ the 4 s hold, plus start margin, plus at least 2 s of identity wait;
    - case timeout ≥ that deadline, plus (b)'s bounded `child.json` wait, plus the claim's 2 s stop confirmation, plus two 5 s settles (the owner and the command group), plus margin.
    - Where that exceeds the file's 20 s, the case's timeout is raised explicitly.

Unchanged: `scripts/trusted-docker-owner.mjs` (its write order), #661's uncaptured path itself, #690's EPERM handling, #687's custody rows.

## Triage

```text
Issue type: test
Fixture level: standard
Upstream suggested level: absent
Blast radius: the custody fixture's cleanup of a captured start whose command identity was never recorded (the :722, :726 and :730 throws); a captured start that ends with result.json and no child.json stays in issued, so it is not misreported
Selected risk packs: Concurrency / shared state / ordering (owner writes vs cleanup's freeze); Resource limits / cleanup (orphaned detached process groups)
Evidence floor: (a) and (b) red before the fix (command group alive after cleanup, no report) and green after; mutant: the early issued.set restored → (a), (b) red; existing trusted-docker fixture, custody, retirement and uncaptured files green; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `trusted-docker-verification`: a captured start whose command identity times out is claimed by the uncaptured mechanism at cleanup.

## Impact

- `platform/test/trusted-docker-fixture.ts`: `captureStart`'s single `issued.set`, and the cleanup comment. It is at 799 of the 800 lines that `max-lines` counts, and the change adds none.
- `platform/test/trusted-docker-uncaptured-fixture.ts`: the release-file polling in `UNPUBLISHED_COMMAND_PRELOAD`.
- `platform/test/trusted-docker-uncaptured-fixture.integration.test.ts`: cases (a) and (b).

## Acceptance-criteria mapping (#692)

- **A deterministic case, red before and green after:** (a).
- **The late-write case:** (b).
- **The cleanup report names the command pid, or "no command started":** the `claimUncaptured` report, asserted in (a) and (b).
- **Custody, retirement and integration files pass:** task 2.1.
