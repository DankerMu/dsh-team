## Risk packs

- **Error handling / partial outputs — selected.** The case failure stays primary; kill and rm failures are labelled residuals; cleanup still runs both steps even when the first fails. Tasks 1.1a, 1.1b, 1.2 rows (a)–(c).
- **Concurrency / ordering — not selected.** Cleanup order (kill stand-in, then rm) is unchanged.
- **File IO / path safety — not selected.** The removal target and options are unchanged; only its error handling changes.
- **Not selected:** API, config, schema, auth, resources, legacy, release, docs. The comment fix (1.3) is a documentation-in-code correction with no behavior.

## Acceptance mapping (#722)

- **AC1** (a case failure plus a cleanup failure reports the case failure first) → 1.1b, 1.2 (a)(b); the passing-case residual → 1.2 (c).
- **AC2** (`pnpm test:integration` passes) → 2.1.
- Issue item #2 (the comment matches behavior) → 1.3.

## Must preserve

- The five existing case blocks keep their assertions, budgets (`CASE_MS`, `SETTLE_MS`) and cleanup order: kill the stand-in first, then remove the tree.
- `killStandIn` still treats only ESRCH as absence.
- A passing case with clean cleanup throws nothing.
- `retireDescendants` and `caseSpawn` behavior is unchanged; only the comment changes.

## 1. Implementation

- [x] 1.1a Add one cleanup helper in the test file, used by all five cases, with injectable steps `kill = killStandIn` and `remove = rm`. **First** keep today's semantics: kill, then remove, with no guard. Also reword the `:14-15` comment ("SETTLE_MS is left for its `finally`") to name the helper.
- [x] 1.2 Add three regression rows. Each starts the wrapper with `startWrapper(['docker', '--help'], true)`, so a live, held stand-in exists. Record each row's red output against 1.1a. Every row records the root its helper was given and removes it with the real `rm` in its own `finally`, so no row leaves a temp directory, red or green.
  - **(a) Case failure, `rm` fails.** The body throws `new Error('case body failed on purpose')`. The remover records the root it was given and rejects with an `EBUSY`-shaped error.
    - Expected: the thrown value is that same case error object, and its message matches `^case body failed on purpose; cleanup: rm: `.
    - The recorded stand-in pid is absent (`process.kill(pid, 0)` gives ESRCH), which shows the kill ran (the kill-then-rm order itself is review-only, unchanged from before).
    - The case removes the recorded root with the real `rm` in its own `finally`.
    - Red: the thrown value is the injected `EBUSY` error.
  - **(b) Case failure, kill fails.** The injected kill first runs the real `killStandIn`, then rejects with a `EPERM`-shaped error.
    - Expected: the same case error, with its message matching `; cleanup: kill: ` and with the tree removed (`existsSync(root) === false`), which shows `rm` still ran.
    - Red: the thrown value is the `EPERM` error, and the tree remains.
  - **(c) Case passes, `rm` fails.**
    - Expected: the helper throws an `Error` whose message matches `^rm: `.
    - Red under 1.1a: the same rejection surfaces as the raw `EBUSY` error, so the assertion on the message prefix fails.
- [x] 1.1b Add the guard, following `withWatch` in `dev-watch.integration.test.ts`:
  - run each step in its own `try`, and collect `kill: <error>` and `rm: <error>`;
  - on a case failure, append `; cleanup: <residual>` to the case's `Error` and rethrow that same object;
  - when the case passed and there is a residual, throw `new Error(residual)`.

  Rows (a) to (c) are green.

- [x] 1.3 Reword the comment at `browser-build-fixture.ts:129`. Other kill errors leave the `map` and propagate, and `caseSpawn` reports them as `unobservable (<name>)`. Do not suggest that the remaining recorded pids are still retired.

## 2. Verification

- [x] 2.1 Red and green runs of the new case; `pnpm test:integration platform/test/verify-browser-runtime.integration.test.ts`; full `pnpm test:integration`; `pnpm lint`, `pnpm typecheck`, `pnpm fmt:check`, `pnpm duplicate-code`.
- [ ] 2.2 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
