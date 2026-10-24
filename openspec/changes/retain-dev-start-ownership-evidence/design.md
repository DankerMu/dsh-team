## Decisions

Change surface: `platform/test/instance-lifecycle.integration.test.ts`: the initial `eventually(... 'source-main ownership')` call site, a local evidence-collecting wait helper, the scenario `finally` cleanup composition, and two new induced cases.

Must preserve:

- Predicate: `(await pidAt(pidfile)) !== undefined`.
- Bound: 5000ms deadline with a 20ms poll.
- Leading error text: `Timed out waiting for source-main ownership`.
- Order: spawn, then wait, then read the PID, then `observeHttp(started.result, 10_000)` equals 0.
- The scenario's assertions and `it` timeout (60_000ms) are unchanged.
- `scripts/dev-server.sh` is byte-identical (SHA256 `0e5c71dc…`).
- Cleanup order:
  1. release readiness;
  2. settle commands (35s);
  3. stop the captured main;
  4. close the Engine;
  5. remove the root.
- No other `eventually` call changes.

Must add/change:

- A local helper (in the test file) that polls the same predicate under the same bound and records first-observed relative milliseconds (from spawn) for each of:
  - `lock`: `<root>/.run/dev.lock` exists;
  - `webBuild`: `<root>/platform/web/dist/index.html` exists;
  - `mainLog`: `<root>/.run/dev.log` exists;
  - `pid`: a valid PID was seen.
- The helper also records the command's `{state: 'running'|'closed'|'error', code, signal, closedMs}` and the final `pidfile: 'missing'|'invalid'|'valid'`.
- On timeout it throws `Error('Timed out waiting for source-main ownership\n' + JSON.stringify(evidence))`. Evidence values are numbers, closed-set strings or null only.
- Cleanup composition:
  - each cleanup step runs in its own try and records `confirmed|failed` under a fixed step name (`readiness`, `commands`, `main`, `engine`, `root`);
  - a scenario failure stays the same thrown error object, rewritten in place: when it is an `Error`, its `message` gets a newline plus `JSON.stringify({cleanup: {<step>: 'confirmed'|'failed'}})` appended, keeping its type, first line (e.g. `Timed out waiting for source-main ownership`) and assertion expected/actual details; a non-`Error` throwable is wrapped once in `Error(String(value) + '\n' + json, {cause: value})`. Cleanup facts therefore reach retained text (vitest prints the message);
  - cleanup failures after scenario success throw `Error('Lifecycle cleanup failed\n' + JSON.stringify({cleanup}))`, step names and outcomes only, never the raw cleanup error text (which can contain root/socket paths); the raw errors are attached only as `cause` (an AggregateError) for local debugging, never in the message.
- New induced cases use the same runtime fixture with the Engine `/version` response controlled, each with an explicit `it` timeout of 30_000ms (the integration project has no `testTimeout`, so vitest's 5000ms default would otherwise apply):
  - **held preflight:** `/version` is held and never released; ownership times out at 5s with evidence `lock`/`webBuild` numbers, `mainLog`/`pid` null, `command.state='running'`, `pidfile='missing'`. Cleanup then settles the command, which ends by the preflight's own 10s abort with code 1 and never spawns main; cleanup confirms command settlement, no PID, no main, Engine closed, root removed.
  - **failed preflight:** `/version` returns 500, so the command closes with code 1 before the deadline. The ownership wait still runs its full 5s bound (no fail-fast) and times out with the exact leading text and evidence `command.state='closed'`, `code=1`, `mainLog`/`pid` null, `pidfile='missing'`.
- The third boundary ("published then cleared"): inside the bound, an observed valid PID makes the wait succeed, so `pid` is always null on the timeout path. Its signature is `mainLog` observed, `pid` null, `pidfile` `missing` or `invalid`, `command.state='closed'`. It cannot be induced deterministically without changing `dev-server.sh` or production code (readiness failure needs a main that exits after PID publication but within one 20ms poll), so it is covered by the evidence shape only, not by an induced case.

Governing invariant: a recurrence of the initial ownership timeout retains enough closed-set facts to distinguish "never published", "exited early" and "published then cleared", without changing what passes or fails, and without raw content.

Sibling surfaces:

- The successor start (L324-328) waits on command settlement, not on this predicate, so it is unchanged.
- The listener-fence, main-exit and cleanup waits watch different events, so they are unchanged.
- `scripts/dev-server.sh` is the producer of the observed files and is read-only here.
- Other lifecycle tests in the file are not touched.

Seams under test: the real `pnpm dev:bg` process plus the canonical script against the test-owned Unix Engine. The thrown error's message (first line unchanged, then the evidence/cleanup JSON) is the public seam.

Required evidence:

- Held preflight: the error message starts with the exact original text, and the JSON has `lock`/`webBuild` as numbers, `mainLog`/`pid` as null, `command.state='running'`, and `pidfile='missing'`. The message JSON also carries cleanup facts all `confirmed`, and no main process remains.
- Failed preflight: message starts with the exact original text; JSON has `command.state='closed'`, `code=1`, `mainLog`/`pid` null, `pidfile='missing'`; cleanup facts all `confirmed`.
- No evidence string contains any of:
  - the fixture model key;
  - the socket path;
  - an environment value;
  - log content.
- Before implementation, both new cases are RED against the current file: the current error has no evidence.
- The original scenario still passes when repeated.

Non-goals:

- Changing the deadline, poll, predicate, retries or fail-fast.
- Changing `dev-server.sh` or production code.
- Writing evidence files outside the test output.
- Claiming that #312 is fixed or flaky.

Review focus:

1. The predicate, bound, error prefix and order are byte-equivalent in effect.
2. Evidence is closed-set and secret-free.
3. Cleanup composition never masks the first failure and still retires main/Engine/root.
4. The induced cases are deterministic and finish well inside the `it` timeouts.
