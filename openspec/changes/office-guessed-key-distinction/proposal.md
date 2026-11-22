# Office guessed-key distinction

## Why

This is slice B of #657, which lists Office stack-fixture assertions that cannot tell a correct implementation from a broken one. Slice C covers idle restore and font ordering, plus the C2 measurement. Slice A, the rewrite case, follows #652.

The plugin derives document keys and file tokens from one per-instance secret, `DSH_TEAM_ONLYOFFICE_FILE_SECRET` (`images/dsh-user/patch-package.mjs:60-67`). The regression worth catching is all instances sharing that secret.

The isolation lane already catches it for tokens. `tB` is B's own secret over A's claims (`bProbeScript`, `office-isolation-stack-fixture.ts:125`), and it expects `BAD_SIGNATURE`. But two key assertions use a secret the test process generates at random (`:298-303`), so any random 64-hex string passes them, and a shared secret goes unnoticed:

- **B1, same-name lane:** `EXPECTED_INFO.kGuessed`, the Command Service `info` while A and B edit. That lane has no `tB`, and `kB` and `distinctKeys` differ even under a shared secret, because the host names `u-${userId}` and the files differ.
- **B1, isolation `(c3)`:** the `hmacGuessed` callback.
- **`tGuessed`** (a random secret over A's claims) adds nothing beyond `tPublic` and `tB`.
- **B2:** the `loaded` gate of `sameNameDocx` (`office-editor-stack-fixture.ts:409-412`) has no integration case. Deleting the `guessedKeyInfo` call, or swapping `kA` and `kB`, fails only in `pnpm test:stack`, about 2 hours.

## What Changes

- **B1:** replace the random secret with B's own per-instance secret, inside B.
  - A's script builds its key input with `KEY_JS` and emits the input string. It contains host name, path, size and mtime joined by `\0`: no secrets, but not argv-safe raw.
  - One shared fragment `CROSS_JS`, embedded by both B-side scripts, receives it JSON-encoded and computes only `kCross = HMAC_sha256(B's env secret, input)`. B never reuses `KEY_JS`, which would read B's own `hostname()`.
  - **Isolation lane:** `kCross` is computed in `bPosition`'s single B exec, before B is retired. A's input comes from `aSetupScript`'s exec, after `register()`. `(c3)`'s `hmacGuessed` callback becomes `kCross`.
  - **Same-name lane:** `guessedKeyInfo` additionally takes B's exec (`sameNameDocx`'s `b.exec`). It computes `kCross` from A's recompute input, then queries `info` with `{k1: kA, kB, k0, kCross}`. `kCross` must be `UNKNOWN_KEY`.
  - **Both lanes:** `kCross ≠ kA` is asserted with no value in the message, and `tGuessed`, its expectation and `aSignScript`'s random-secret argument are deleted.
- **B2:** extract the `loaded` gate body into an exported function. An integration case on a stand-in lane asserts:
  - the call order: A registry, B registry, A recompute (which emits the input), B cross, holder query;
  - the argument flow: `verify({k1: kA})`, the info keys `{k1: kA, kB, …}`, and B receiving A's input;
  - that the result lands in `met.info`.

  The one wiring line in `sameNameDocx` that calls the gate remains stack-only.

- **Evidence and spec:**
  - `EXPECTED_INFO` and `EXPECTED_ATTACK` rename the guessed entries to `kCross`, as do `office-editor-stack-fixture.integration.test.ts:244` and `docs/LOCAL_STACK.md:195-196`.
  - A `stack-verification` requirement states the cross-instance check and that it fails under a shared secret.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Office isolation/editor stack fixtures; a wrong cross-key computation could falsely pass a shared-secret regression or leak a key into evidence; B's script runs inside B with B's env
Selected risk packs: Auth / permissions / secrets; Error handling / rollback / partial outputs
Evidence floor: under a shared-secret stand-in the new checks fail and the old kGuessed/hmacGuessed pass (recording the gap), different secrets pass; B2 mutants red at the integration layer; pnpm check; exact-head local pnpm test:stack; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the Office isolation and same-name lanes check keys computed with another instance's secret.

## Impact

- `platform/test/office-isolation-stack-fixture.ts`: `aSetupScript`, `bProbeScript`, `bPosition`, `aSignScript`, `aGuessScript`, `guessedKeyInfo`, `EXPECTED_*`, `Text`.
- `platform/test/office-editor-stack-fixture.ts`: the gate extraction and `b.exec`.
- The integration tests for both.
- `docs/LOCAL_STACK.md:195-196`.

No change to `platform/src/`, plugins, images or any critical path. The stack budget is unchanged because no new waits are added.
