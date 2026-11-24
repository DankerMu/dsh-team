# Design

Change surface: `office-isolation-stack-fixture.ts` (`aSetupScript`, `bProbeScript`, `bPosition`, `aSignScript`, `aGuessScript`, `guessedKeyInfo`, `officeIsolation`, `EXPECTED_INFO`, `EXPECTED_ATTACK`, `Text`); `office-editor-stack-fixture.ts` (`sameNameDocx`'s `loaded` gate).

Must preserve:

- Every distinguishing expectation: k0 → 1; k1/kB editing with `users: ['dsh']`; `tB`/`tPublic` `BAD_SIGNATURE`; only T reads and only the JWT-signed k1 saves.
- `guarded`/`verify` scrubbing.
- `bPosition` retires B exactly once, on success and on failure. B's own failure precedes a retire failure, with no `cause`.
- `providerCounts` is unchanged.
- The isolation event order `provider setup b retire sign attack read provider clean` (integration test `:212`). Only B's in-exec computation is added; there is no new exec event.
- uid 1001 instance scripts that read only their own environment.

Must add/change:

- `aSetupScript` and `aGuessScript` emit A's key `input`.
- One shared fragment `CROSS_JS` JSON-decodes A's input and computes `kCross = HMAC_sha256(B env secret, input)`. `bProbeScript` and the standalone B cross script both embed it; there is no second implementation (Code Canonicality). In the isolation lane A's input reaches `bProbeScript` as its own argument, never merged into `claims`, so `tB` still signs A's claims unchanged.
- `guessedKeyInfo` takes B's exec.
- `kGuessed` and `hmacGuessed` become `kCross`. `tGuessed`, `EXPECTED_ATTACK.file.guessed`, `aSignScript`'s `argv[2]` and the random-secret code are deleted.
- The gate function is exported.

Governing invariant: a key computed with any secret other than A's own is unknown to the Command Service and refused by A's callback, and each check fails if all instances share one secret.

Sibling surfaces:

- **Isolation lane:** `kCross` is computed inside `bPosition`'s one B exec, before `retire`, from `aSetupScript`'s input. It is used by the `(c3)` callback.
- **Same-name lane:** `guessedKeyInfo` runs, in order, A recompute (input), B cross through `b.exec` (B still editing), then the holder `info`.
- `distinctKeys`, `(c1')` signing, the evidence line through the existing fixture exports, and `LOCAL_STACK.md:195-196`.

Secrets: B's per-instance secret never leaves B. `kCross` joins every redaction list: `bPosition`'s `[k1]`, `verify('(c2)')`'s `[k1, kB, tB]`, the `(c1')`/`(c3)` `secrets` and `guessedKeyInfo`'s `secrets`. It also joins the `Text` union. It never appears in evidence or assertion messages. Keys already travel in argv and script sources inside the lane (`claims`, `platformAttackScript`, `namespaceInfoScript`); this change adds no new channel. A's `input` is not secret and may appear in a `verify` failure's observed JSON.

Seams under test:

- **Script layer:** run A's key script and the standalone B cross script (which embeds `CROSS_JS`) locally, with temp files and env as in the existing `local()` precedent (integration test `:284-300`).
  - With the same env secret, `kCross === A.k1`. With different secrets, they differ.
  - The input's host name must differ from the local `hostname()`, so that a B script that reads its own host name fails.
  - A string-level case asserts that `bProbeScript` embeds `CROSS_JS`, which ties the isolation lane's derivation to the tested one.
- **Fixture layer:** `fakeLane`/`guessLane` stand-ins answer `kCross = k1`, or the holder answers EDITING for `kCross`. The fixture must throw, with no value in the message.
- **Gate layer:** the extracted gate on a stand-in lane covers call order, argument flow and `met.info`.

Required evidence:

- Under a shared-secret stand-in (same secret at the script layer; `kCross = k1` or holder EDITING at the fixture layer), the new checks fail. With different secrets they pass.
- Under the same stand-in, the old `kGuessed`/`hmacGuessed` checks still pass, which records the gap.
- B2 mutants fail at the integration layer: the `guessedKeyInfo` call deleted, `kA`/`kB` swapped, B not given A's input.
- Exact-head `pnpm test:stack`: the isolation and same-name lanes pass with `kCross` unknown and refused.

Non-goals: A and C1–C3 of #657; the key derivation; any new evidence field carrying a value.

Review focus:

- `kCross` is computed with B's real secret inside B, from A's input.
- Redaction lists include `kCross`.
- `bPosition`'s retire/failure semantics are unchanged.
- The gate extraction preserves order and `met.info`.

Noted for the implementer (pre-existing): `bPosition`'s `JSON.parse(stdout)` failure can echo a stdout prefix. When adding `kCross` to that stdout, parse it the way `guarded` does, discarding the output on failure.
