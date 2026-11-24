# Integration load deadlines: the secondary table

## Why

This is #687 slice 3, the last one: the secondary table, rows #9–#13. The issue saw them only at 1-minute load 67→116. Slice 1 (#708) handled the main table, and slice 2 (#712) the custody rows.

The issue's acceptance criteria for this table:

- At minimum, budget declaration and attribution.
- A/B sites (#9, #12, #13): an explicit case budget, inner deadlines strictly below it, and a timeout that names its phase.
- C sites (#10): a case that distinguishes the fix, or a statement of how the assertion is event-synchronized.
- Stability at load ≥ 67 is a secondary goal, not a merge condition.

Line numbers are on main `3c28e2a`.

**#9 (class B), `platform/test/browser-exec.integration.test.ts:180-193`.**

- The `it.each` (`none`, `driver`, `producer`) has no third argument, so it inherits vitest's 5 s default (`vitest.config.ts:23` sets no `testTimeout`). The file's other default-bound cases are :151, :458, :496, :521, :552, :577 and :598.
- On the green path the mock client prints `ready` and is SIGKILLed at once (`browser-runtime-fixture.ts:377`, :396-401). The 15 s client timer (:380-382, `Owned browser protocol client timeout`, already phase-named) is therefore not what consumes the 5 s.
- The fixed inner waits that do run are:
  - **`withAuditReceipt`'s registration child.** It is called without a `caseMs`, so it runs `unbudgeted` with a 5 s SIGTERM (`trusted-docker-audit-fixture.ts:21-22`, :103, :133-155).
  - **`ordinarySubmission`**, a `spawnSync` with `timeout: 5000`.
  - **`processBirth`'s 2 s timer** (`scripts/probe-browser-native.mjs:97`).
- Under a raised runner bound, the first two still end unattributed, as `expected null to be 0`. That is #1's form, and it breaks the existing requirement "Synchronous child waits fit inside an explicit case budget" (`openspec/specs/integration-test-budgets/spec.md:9-16`).

**#10 (class C, inferred by the issue), same file :315.**

- The site is `expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual([])`. The recorded failure was `expected [ Array(1) ] to deeply equal []`, which is most likely chai's truncation of a one-element array of marker names (40-character threshold; unmeasured).
- The read is already ordered after settlement:
  - the child's `close` handler (`browser-runtime-fixture.ts:412-428`) calls `publish`, which is synchronous through its `unlinkSync` of the marker (`scripts/verification-submission-storage.mjs:228-245`);
  - only then does `execBrowser` reject, and the case awaits that rejection (:310-314).
- So no timing window exists. The marker can survive on exactly one path: `publish` throws, and :419-424 replaces that error with `failure`. `.rejects.toBe(failure)` still passes, and :315 is the only check that notices.
- The row is therefore a masked publication error, not a race.

**#11 (class D), `platform/test/gateway-http-fixture.ts:207-212`.**

- `observeHttp(observation, timeoutMs = 2_000)` is event-based: it fails a stalled peer and never stands in for an event. Its 2 s default has no recorded basis.
- The callers that use the default are:
  - `reader()`, for every frame read (:251);
  - `withUpstream`'s cleanup, with a literal `2_000` (:107, :109);
  - the websocket cases at :102, :173, :177-178 and further sites.
- Those cases run under vitest's 5 s default. One case makes up to about 15 sequential observations, plus non-observation costs such as `injectRegister`'s scrypt and `once(connect)`.
- `observeHttp` has 25 caller files, 13 of them integration files that rely on the default.
- `gateway-websocket.integration.test.ts` has about 18 lines of `max-lines` headroom.

**#12 (class B), `platform/test/login-throttle.integration.test.ts:69-83`.**

- Within the 5 s default, the case registers an account and makes 10 wrong-password logins and 1 correct login over real TCP. Each login hashes with real `scrypt`, and only `Date` is faked.
- `postJson` (`auth-tcp-fixture.ts:94`) carries no signal, so a stalled request ends as a bare `Test timed out`.
- :85, :123, :156 and :206 have the same shape.

**#13 (class B), `platform/test/ragflow-proxy-auth.integration.test.ts:224-239`.**

- Within the 5 s default, the case starts and stops one app and proxy for each of the 11 rejection reasons, in sequence.
- `withProxy`'s `fetch` (:97) carries no signal. Each rejection tuple has a label, which :226 discards (`[, options, request]`).

## What Changes

- **A measuring pass first, with nothing permanent.**
  - The four touched test files' case budgets are temporarily raised to 60 s, so that no duration is truncated.
  - A temporary probe in `observeHttp` records settle times.
  - Five runs of those four files under `yes` generators. Generators are added after a warm-up until the 1-minute load is at least 67, and a run that starts below 67 is discarded and repeated.
  - Durations come from vitest's JSON reporter.
  - Everything temporary is reverted. The maxima and loads go into the PR.
- **Each touched file gets a named case budget constant**, following slice 2.
  - It applies as the third argument where Prettier keeps the call shape; otherwise through `vi.setConfig({ testTimeout })`, which vitest resets per file.
  - Its comment states the basis: the measured maximum and load, and the margin.
- **#9: route the case's synchronous children through the budget.**
  - **Every `withAuditReceipt` call in the file passes the case budget**, following the existing pattern of `trusted-docker-audit.integration.test.ts:219-221`: :152, #9's own `it.each` at :194, and the one inside `withBoundExec` (:122-125). Each registration child is then killed at the case deadline with `browser registration: killed at the case deadline`.
  - **`ordinarySubmission`** (`trusted-docker-audit-fixture.ts:65`; called at :425 inside #9's `it.each`) gains an optional `spawn` parameter. Its default keeps `timeout: 5000` for the callers in `trusted-docker-audit.integration.test.ts` and `submission-call-evidence.integration.test.ts`. :425 passes the receipt context's budgeted `spawnChild`.
  - The file's default-bound cases all get the declared budget. It is set above the 15 s client timer plus the measured setup and cleanup, so a hung client fails at that timer, with its own message.
- **#12 and #13: per-step bounds that name the step.**
  - Each request gets an `AbortSignal` bounded by the case's remaining budget. The case deadline is taken from `performance.now()`, because #12 fakes `Date` and jumps it with `setSystemTime`; #13 uses the same form. The requests are: #12's `postJson` call sites, with an optional `signal` added to `auth-tcp-fixture.ts`; #13's `withProxy` `fetch`.
  - A stall fails with the step's identity, such as `login attempt 7: …`, or `ragflow rejection <label>: …` using the label that :226 now keeps.
  - The budgets: #12's is the per-login cost times the logins in the largest case, plus registration; #13's is the per-app cost times `rejections.length`. Each has a margin.
  - #13 stays one case, because its aggregate assertion compares all answers byte for byte.
- **#11: name the default; budget the websocket file.**
  - `2_000` becomes a named constant, `HTTP_OBSERVATION_MS`, with its measured basis. It also replaces the two literals in `withUpstream`.
  - It keeps its value unless the loaded settle maximum exceeds half of it. If it must rise, the slice stops and reports: raising it would take attribution from the 13 integration files that rely on the default under 5 s.
  - `gateway-websocket.integration.test.ts` declares one budget through `vi.setConfig`, above the largest case's sum of sequential observations at the default (`reader()` reads and cleanup included) plus its measured non-observation cost. That is a net +1 to +3 counted lines.
- **#10: a statement, with no wait.**
  - A comment at :315 states the ordering, and that a non-empty directory means `publish` threw inside `close` and was masked by `failure`.
  - If the measuring pass reproduces the row, the fix exposes the masked publication error as the rejection's `cause` instead of adding any wait. The fixture is then updated.
- **Red evidence (temporary probes, then reverted):**
  - a hung client fails with `Owned browser protocol client timeout` before the budget;
  - a stalled registration fails with `browser registration: killed at the case deadline`;
  - a stalled login and a stalled proxy request fail naming the attempt or the label;
  - each `vi.setConfig` default goes red at 50 ms.
- **Out of scope, reported only:**
  - `sendHttp`'s own `AbortSignal.timeout(5_000)`;
  - `ragflow-proxy-auth.integration.test.ts:330`'s `< 5_000` assertion;
  - the default-relying `observeHttp` callers outside the websocket file;
  - `platform/src/**`, `scripts/**` and `vitest.config.ts`.

No assertion is weakened or removed. This slice branches after #712 merges. Its PR says `Closes #687`, as the last slice.

## Triage

```text
Issue type: test
Fixture level: standard
Upstream suggested level: absent
Blast radius: case budgets in four integration files; budgeted children in browser-exec via the audit fixture; an optional signal in auth-tcp-fixture; observeHttp's default named (value unchanged unless measured)
Selected risk packs: none beyond budget arithmetic (no product timers; #10's ordering argued from code)
Evidence floor: the measuring pass (60 s budgets, 5 runs at load ≥ 67, durations and settle maxima); the red attribution probes above; the four files green; 5 loaded full pnpm test:integration runs (load ≥ 13 and < 67) with load and result; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `integration-test-budgets`: the secondary-table cases declare measured budgets; their inner deadlines stay below them.

## Impact

- `platform/test/browser-exec.integration.test.ts`; `platform/test/trusted-docker-audit-fixture.ts` (the optional `spawn` in `ordinarySubmission`, and a budget parameter in `withAuditReceipt` only if it lacks one).
- `platform/test/browser-runtime-fixture.ts`: only if #10 is reproduced and the masked error becomes `cause`.
- `platform/test/login-throttle.integration.test.ts`, `platform/test/auth-tcp-fixture.ts`
- `platform/test/ragflow-proxy-auth.integration.test.ts`
- `platform/test/gateway-websocket.integration.test.ts`, `platform/test/gateway-http-fixture.ts`

## Acceptance-criteria mapping (#687)

- **#9, #12 and #13:** explicit budgets, with every inner wait below them and named: the budgeted children, and the per-step signals.
- **#10:** the event-synchronization statement, with the masked-publication path named.
- **#11:** the default's measured basis, and websocket budgets above its sum.
- **Load ≥ 67:** the measuring pass records it, as the secondary goal.
- **The five loaded full runs:** across all nine files.
