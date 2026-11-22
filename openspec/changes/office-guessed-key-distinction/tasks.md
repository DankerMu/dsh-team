## Risk packs

- **Auth / permissions / secrets — selected.** B's per-instance secret never leaves B. `kCross` joins every redaction list and the `Text` union, and stays out of evidence and messages. Tasks 1.1, 1.2.
- **Error handling / rollback / partial outputs — selected.** `bPosition`'s retire-once semantics and failure order are kept, `guarded`-style parsing is used for the new stdout field, and gate failures stay attributable. Tasks 1.1, 1.3.
- **Not selected:**
  - product code, config and release;
  - concurrency (no new waits; the stack budget is unchanged).

## Acceptance-criteria mapping (#657, slice B)

- **B1** (the replaced guessed key fails under a shared secret) → 1.1, 1.2, 1.4, 2.1.
- **B2** (deleting `guessedKeyInfo`, or swapping kA/kB, fails at the integration layer) → 1.3, 2.1. The single gate-call line in `sameNameDocx` stays stack-only.
- **Shared AC** (red→green per new assertion; nothing lengthened or skipped; only the redundant `tGuessed` removed; exact-head `pnpm test:stack`) → 2.1–2.3.
- **A1–A4, C1–C3** → later slices. The PR says `Refs #657`.

## Must preserve

- Every distinguishing expectation other than the renamed or removed guessed entries.
- The scrubbing.
- `bPosition`'s retire-once semantics, with B's failure before the retire failure and no `cause`.
- `providerCounts` unchanged.
- The isolation event order (integration test `:212`), with no new exec event.
- uid 1001 instance scripts that read only their own environment.
- The evidence-line format, apart from the renamed fields.
- The 800-line and complexity limits.

## 1. Implementation

- [x] 1.1 Isolation lane:
  - `aSetupScript` emits A's `input` after `register()`.
  - A shared `CROSS_JS` fragment does the HMAC: B's env secret, JSON-decoded input, no `KEY_JS`. `bProbeScript` embeds it and receives A's input as its own argument, never inside `claims`, then outputs `kCross`.
  - `bPosition` parses guarded and adds `kCross` to its redaction.
  - Assert `kCross ≠ k1`.
  - `(c3)`'s `hmacGuessed` callback becomes `kCross`.
  - Delete `tGuessed`, `EXPECTED_ATTACK.file.guessed`, `aSignScript`'s random-secret argument and `randomBytes`: `tB` (`bProbeScript:125`) is already B's signature over A's claims.
- [x] 1.2 Same-name lane:
  - `guessedKeyInfo(lane, b, kA, kB, file)`, in order:
    - A recompute emits the input;
    - a standalone B cross script, embedding `CROSS_JS`, runs through `b.exec`, under `guarded` with its own label and a secrets list that includes `kCross`;
    - the holder `info` asks for `{k1: kA, kB, k0, kCross}`.
  - `EXPECTED_INFO.kCross` is `UNKNOWN_KEY`.
  - Rename in `office-editor-stack-fixture.integration.test.ts:244` and `:260`.
  - `docs/LOCAL_STACK.md:195`: rename the guessed key.
  - `docs/LOCAL_STACK.md:196`: remove 「猜测密钥」 from the 403 file list, because `tGuessed` is deleted with no replacement. Rename the guessed-key callback in the callback list to the key B's secret produced.
- [x] 1.3 Extract `sameNameDocx`'s `loaded` gate body into an exported function and pass `b.exec`. Add an integration case on a stand-in lane that asserts:
  - the order A registry, B registry, A recompute, B cross, holder query;
  - the argument flow;
  - `met.info`.
- [x] 1.4 Stand-ins:
  - **Script layer:** A's key script and the standalone B cross script run locally (temp files and env, as in the `local()` precedent). With the same secret `kCross === k1`; with different secrets they differ. The input's host name differs from the local `hostname()`. A string case asserts that `bProbeScript` embeds `CROSS_JS`.
  - **Fixture layer:** `fakeLane`/`guessLane` answer `kCross = k1`, or the holder answers EDITING for `kCross`, and the fixture throws with no value in the message.
  - Show the B2 mutants red: the call deleted, `kA`/`kB` swapped, B not given A's input.

## 2. Verification

- [ ] 2.1 Record in the PR:
  - under a shared-secret stand-in, the new checks fail while the old `kGuessed`/`hmacGuessed` pass;
  - with different secrets, the new checks pass;
  - each B2 mutant fails.

  Then run `pnpm check`.

- [ ] 2.2 Exact-head local `pnpm test:stack`: the isolation and same-name lanes pass, with the inventory/volume fence.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` with confirmed cleanup. The repository requires these for every `platform/test/` change; the sibling change #648 needed them for the same reason.
