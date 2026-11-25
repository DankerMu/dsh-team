# Keep the Office stack lanes' failure reports scrubbed and complete, stdin errors contained, evidence complete

## Why

These are leftovers from issue #717 (#650, #654, #663, #671, #681). Line numbers refer to main `0e4ee70`.

1. **Double failures print raw members under a fixed message (items 1–4).**
   - `retiringOnError` (`office-editor-stack-fixture.ts:298-311`) throws `AggregateError([error, failure], <fixed text>)`. Callers are editor `:518`, forgotten `:498-505`, external `:245` and idle `:243`.
   - The workbench close path (`stack-browser-fixture.ts:368-376`) does the same, and rethrows a close-only failure raw at `:373`.
   - Vitest 5.0.2 prints a top-level `AggregateError` only through its members (`run.C5UmxDPh.js:3976`). A nested one gets its fixed message plus a "Serialized Error" dump of its raw `errors` (`index.C-uw7tH9.js:9091-9154`).
   - The real lane is always nested, because `user-image-fixture.ts:586` wraps each scenario. So the report shows the fixed text plus the **unscrubbed** retire or close failure. That is a leak of what #671's scrub protects.
   - `scrubbedChain` (`:162-170`) and the hand-written `sessionFailure` loop (`office-forgotten-stack-fixture.ts:347-365`) cannot fold aggregate members.
2. **Uncaught EPIPE (item 5).** The identical `local` runners in `office-isolation-stack-fixture.integration.test.ts:275-281` and `office-forgotten-stack-fixture.integration.test.ts:56-62` call `stdin.end(input)` with no `error` listener. A child that exits without reading raises an uncaught `write EPIPE` after every test has passed, and vitest exits 1. Reproduced 30/30 with an 8 MB input to a non-reading child.
3. **Forgotten evidence lacks the allowed unload sources (item 6).** `OfficeForgottenEvidence` (`:244-251`) has no list, and the lane returns only `{ kA, closed }` (`:316`). The evidence reaches the stack line verbatim as `officeIsolation.forgotten` (`office-isolation-stack-fixture.ts:260-263`, `platform-stack.stack.test.ts:548,904`).
4. **Masks depend on Chinese text (item 7).** The save-error notice is masked by its Chinese text (`stack-browser-fixture.ts:304-306`, `office-rewrite-stack-fixture.ts:61-67`). With a non-Chinese UI nothing is masked, and nothing fails.
5. **Two surviving mutants and a dead branch (items 8, 9).**
   - Mutant: dropping `DS_SCRIPT`'s `^` (`:50`).
   - Equivalent mutant: dropping `scrubbedEvidence`'s `unloadViolations` line (`:155`).
   - Dead branch: `removeProbe`'s `isAbsentResource` branch (`document-server-net-fixture.ts:327-331`). Its only lane is the bounded command, `docker rm -f` exits 0 when the container is absent, and `redactResult` rewrites non-inspect failures.

## What Changes

- **One scrubbed chain.**
  - `scrubbedChain(cause, secrets = [])` walks `.cause` and expands `AggregateError.errors`. Each branch is bounded at 8 reasons, so a deep lane chain never truncates the retire or close reason.
  - Non-`Error` values go through a total renderer: JSON when possible, otherwise a fixed `unknown failure`. It never returns `undefined` and never throws on circular values or BigInt. Every part is scrubbed.
  - `sessionFailure` drops its own loop and keeps passing `kA` as a secret.
- **Double failures are plain errors.**
  - **Lane plus retire.** `retiringOnError` throws a plain `Error`, never an `AggregateError`, with no `cause` and no `errors`. Its message is the fixed text followed by the scrubbed chain of both failures.
  - **Session plus close.** The failure stays a `StackWorkbenchFailure`, with the same prefix and the same scrubbed `evidence`. The close reason is folded into its message, and it has no `errors`.
  - **Close only.** A close-only failure is rethrown as a scrubbed plain `Error`.
  - **Same-name editor case.** `sameNameFailure` already embeds the A and B chains, so its retire wrapper must not print a reason twice.
- **stdin.**
  - One shared runner, in a non-test module with its own sibling test, replaces both duplicated `local` runners.
  - It ends stdin with an `error` listener that ignores only `EPIPE`, and rejects on any other stdin error.
  - `e2e-command-fixture.ts:51` swallows every stdin error, so it does not fit.
- **Forgotten evidence.**
  - `OfficeForgottenEvidence` gains `unloadViolations: { edit: string[]; recover: string[] }`, built with `scrubEach` from the two sessions' evidence.
  - It reaches the stack line through the existing `officeIsolation.forgotten` path. `platform-stack.stack.test.ts` is unchanged.
- **Mask locale.**
  - `workbenchSession`, when `names.masked` is set, waits once on the DSH page after `ready()` and before `body` for `<html lang>` to start with `zh`. The wait is bounded and uses `until`.
  - Provenance:
    - The released `@deepseek-ai/dsh-client-locale@0.2.1-rc.2` sets `<html lang>` (`lib/client.js:1172-1175`, `zh` → `zh-CN`), and it does so when it applies and on every change.
    - `plugins/zh-locale` calls `setLocale('zh')`.
    - The platform login page is statically `zh-CN`, so the check never runs there.
  - If the locale check fails, the session fails with a named reason and **skips the failure screenshot**. The notice cannot be captured unmasked.
- **Mutants.**
  - A prefixed `DS_SCRIPT` path counterexample.
  - A `not.toBe` assertion that `scrubbedEvidence` returns a new `unloadViolations` array.
  - The dead `isAbsentResource` branch is deleted, along with its now-unused import (`document-server-net-fixture.ts:9`) and its test (`document-server-net-fixture.integration.test.ts:750-764`).

## Triage

```text
Issue type: test-infrastructure bugfix (incl. a report-time redaction leak)
Fixture level: compact (legacy-compatibility pack selected, but test-only with no product surface)
Upstream suggested level: absent
Blast radius: platform/test stack fixtures and integration tests; the local full-stack lane's failure reports and evidence line; no product code
Selected risk packs: Error handling; Security (redaction); Legacy compatibility
Evidence floor: red-before/green-after integration cases per item (item 5: the single file's vitest exit code); pnpm test:integration; one local pnpm test:stack on the final head; exact-head VPS pnpm test:docker + pnpm test:deploy
```

## Capabilities

### Modified Capabilities

- `stack-verification`:
  - Double failures are plain errors whose messages carry every scrubbed cause, and they hold no raw member.
  - Masked sessions require a Chinese UI.
  - The forgotten evidence lists its allowed unload sources.
  - Child stdin errors other than EPIPE fail the test.

## Impact

- **Fixtures.** `platform/test/stack-browser-fixture.ts`, `office-editor-stack-fixture.ts`, `office-forgotten-stack-fixture.ts`, `office-external-stack-fixture.ts`, `office-idle-stack-fixture.ts`, `document-server-net-fixture.ts`, plus their `*.integration.test.ts`, and `office-isolation-stack-fixture.integration.test.ts`.
- **New file.** One shared stdin runner with a sibling test.
- **Out of scope.**
  - `docker-command.ts:229` uses the same unlistened `stdin.end(input)` in real lanes (`holderRead`). It is reported separately.
  - #716 touches the same files on different lines, so the two land one after the other.
