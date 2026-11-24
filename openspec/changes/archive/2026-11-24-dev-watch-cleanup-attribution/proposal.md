# Dev-watch cleanup attribution

## Why

Issue #662. Line numbers refer to `platform/test/dev-watch.integration.test.ts` on main `a246263`.

`withWatch` (`:218-241`) promises that "cleanup never hangs nor replaces the case's failure" (`:217`). It breaks that promise in two places.

- **An unguarded `rm(root)` (`:233`).** The call sits between computing `residual` and throwing. If `rm` rejects, its error replaces everything else:
  - when the case failed and left a residual, both the failure and the residual are lost;
  - when the case failed but stopped cleanly, the failure is lost;
  - when the case passed but left a residual, the residual is lost and the failure is attributed to `rm`.

  The likeliest time for `rm` to reject is exactly when it matters most: the group outlived SIGTERM and may still be writing `receipt.json` under `root`. `fs.promises.rm` has `maxRetries: 0`, so it does not retry on ENOTEMPTY or EBUSY. That last point is an inference; it was not reproduced.

- **`stop()` (`:197-215`) cannot tell outcomes apart.**
  - After the SIGTERM wait times out and SIGKILL then succeeds, it returns only the SIGTERM timeout text. That text carries a snapshot taken at timeout time, `pnpm group alive`, so the report reads as if the group survived.
  - When the SIGKILL call itself throws (an errno other than ESRCH or EPERM from `signalGroup`, `:76-86`), it returns a bare `Error: kill …` with no phase.

## What Changes

- **`stop()` labels every outcome by phase.** It returns `undefined` on a clean stop. Otherwise it returns one of these strings:
  - `SIGTERM: <timeout error>; SIGKILL: retired`, when the group was absent after SIGKILL;
  - `SIGTERM: <timeout error>; SIGKILL: <timeout error>`, when the group was still present after `KILL_MS`. The `until` text already names `group exit after SIGKILL`.
  - `SIGTERM: <timeout error>; SIGKILL: failed: <error>`, when the SIGKILL call threw.

  The two SIGKILL paths are told apart by where the error came from (the call or the wait), not by matching message text.

- **`withWatch` guards `rm`.** It catches a rejection from `rm(root)` and appends it to the cleanup residual as `rm: <error>`. The residual's parts are joined with `; `. Then:
  - a passed case with a residual throws `new Error(residual)`;
  - a failed case gets `; cleanup: <residual>` appended to its message and rethrows its own error.

  The order of steps stays the same: stop, then rm, then decide.

- **The existing "ignores SIGTERM" case's regex (`:345`)** is updated to the labelled form and anchored with `; SIGKILL: retired$`.
- **New case: the case failure survives an `rm` failure.**
  - **Seam.** `withWatch` takes an optional `remove` parameter that defaults to `rm`. The case's body fails on purpose, and it passes a remover that rejects with an `EBUSY`-coded error. The remover records the `root` it was given, and the case removes that root in its own `finally`.
  - **Red, before the guard:** the error thrown is the remover's `EBUSY` error.
  - **Green, after the guard:** the message starts with the case's failure text, contains `; cleanup: `, and ends with a `rm: Error: …EBUSY…` segment. A slow stop may legitimately put a `SIGTERM:` segment before `rm:`.
- **New case: the real `stop` with a stub `Watch`.** The stub has a fake pid, `exited: () => false`, and an `attribute` that returns `new Error(`Timed out waiting for ${phase} after ${elapsedMs} ms`)`. `vi.spyOn(process, 'kill')` uses a `mockImplementation` that never calls through: signal 0 and SIGTERM return `true`. Calling through could hit a real process group with the fake pid. The spy is restored in a `finally`. It is parameterized:
  - **SIGKILL throws `Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })`.** The residual contains `; SIGKILL: failed: Error: kill EINVAL` and does not contain `group exit after SIGKILL`.
  - **SIGKILL returns `true` while signal 0 stays `true`.** The residual contains `; SIGKILL: Error: Timed out waiting for group exit after SIGKILL` and does not contain `failed:`.

  `stop` and `signalGroup` gain no parameter. The deadlines derive from `caseEnd` and the named constants.

## Triage

```text
Issue type: bugfix (test diagnostics)
Fixture level: compact (one test file's cleanup reporting; no production code, entrypoint, schema or format change; the deleted path is the case's own mkdtemp root, not a publish/delete surface)
Upstream suggested level: absent
Blast radius: dev-watch integration file's failure reporting only; a wrong change could hide a case failure or skip removing the temp root
Selected risk packs: Error handling / rollback / partial outputs (cleanup must not replace the case failure; residual labelled by phase)
Evidence floor: new rm case red before / green after; SIGKILL label case; existing four it.each cases and two attribution cases green three runs in a row; pnpm lint/typecheck/check; exact-head VPS lane (repository gate)
```

`design.md` is omitted (level compact).

## Capabilities

### Modified Capabilities

- `built-artifact-verification`: development watch cleanup keeps the case's failure and labels what it left behind.

## Impact

- `platform/test/dev-watch.integration.test.ts` only.

This change leaves out the same `finally` pattern in `verify-browser-runtime.integration.test.ts:183-242`, which the issue's "affected surface" lists as optional. It is reported for a later touch.
