# Design

## Change surface

- `stack-browser-fixture.ts`: `redactSecrets`, `scrub` and `StackWorkbenchFailure`.
- The editor, hints, rewrite and forgotten lanes: where they call or format these helpers.
- Updated imports of `redactSecrets`.

## Must preserve

- `workbenchSession`'s raw evidence on success. Lanes assert on it and summarize it.
- The `StackWorkbenchFailure` message prefix `Stack workbench <label> failed (<counts>): `.
- The ordering at `:258-262`: the session failure first, then a close failure.
- `officeEditorLine`, `officeRewriteLine` and the typing line. Their existing tests, including `office-rewrite-stack-fixture.integration.test.ts:136-156`, pass unchanged.
- The forgotten lane's labels and `scene` fields.
- The non-Office raw `toEqual`s in `platform-stack.stack.test.ts`, which run on successful sessions only.

### Updated assertions

These are the only existing assertions that change. Each is listed in the PR.

- `stack-browser-fixture.integration.test.ts:342` (`failure.cause`).
- `office-forgotten-stack-fixture.integration.test.ts:375-377`, which expects `?EIO=4`; the query is now removed.
- `office-forgotten-stack-fixture.integration.test.ts:383-384`, which uses the old `scrub` signature.
- The `redactSecrets` import sites.

### Accepted change

The forgotten lane's reopen alert text passes through `scrub` (`:422`). It may change wherever the shared rule differs from the old 64-hex-only rule. No real alert text with a key or query has been observed, and the PR states this.

## Governing invariant

A stack workbench failure contains no document key and no URL query anywhere vitest prints it:

- its message;
- all of its own properties;
- the diffs of failing matchers in the editor, rewrite and hints lanes.

It still names its label, its counts and its scrubbed cause messages, and those remain readable diagnostics.

## Decisions

### Rule constraints for `scrub`

The rule is not fixed here; the implementer chooses it within these constraints.

1. Known secrets are replaced, and so is every 64-hex run.
2. A query or hash is removed only from a URL (scheme or path). Free-text `#`, such as `"focus":"BODY#"` or `locator('#editor_sdk')`, is kept.
3. These failure inputs stay readable after scrubbing: a `typeAndSave` frames JSON, a Playwright `#id` locator, and `net::ERR_CONNECTION_REFUSED` / `ERR_*` codes.
4. The rewrite lane's existing line test (`:136-156`) passes byte-identically, so the tokens and nonces it redacts today stay redacted.

5. Any exemption that keeps `ERR_*` readable is limited to uppercase letters and underscores. The rewrite case's `EDITOR` + 32 uppercase hex nonce must stay redacted, and so must a 20+-character mixed run inside a path.
6. Inside a URL, query removal stops at quotes and JSON delimiters as well as whitespace.

### Other decisions

- **Apply per element.** `scrub` runs per list element or per cause message, never on a JSON-serialized whole.
- **Scrub at construction, plainly.** The scrubbed `evidence` is a normal property. Non-enumerability would not hide it from vitest, so it buys nothing.
- **No `cause`.** The throw-site stack is given up for safety on every lane, and this is accepted.
- **Coverage wording.** For document keys, the new rule covers in practice what the old 64-hex rule covered, but it is not strictly broader.

## Sibling surfaces

- Non-Office lanes share `StackWorkbenchFailure`. Their failures become scrubbed but stay readable (constraint 3).
- The external lane is excluded; see the proposal.

## Seams under test

- **Class:** construct `StackWorkbenchFailure` directly.
- **Lane drivers:** `vi.mock('./stack-browser-fixture.ts', importOriginal)` replaces only `workbenchSession`, which then rejects with a real, key-bearing `StackWorkbenchFailure`. The lanes run against fake lanes that provide only what each lane calls before the session: `exec`, `run`, `documentServerReady`, `providerCounts` and the rest, as the implementer finds them.
  - The editor case goes through `sameNameDocx`'s `AggregateError` or `retiringOnError`, and every entry in `errors` is checked.
- **Red-on-unscrub cases for the editor `seen` and hints `:403` / `:404-409`:** the mock resolves the session with key-bearing evidence. For the editor, the mock also calls `onResponse` with a ≥400 response.
- **Hints matcher:** fed key-bearing lists. The assertion covers the `AssertionError`'s `.message` and the serialized `actual` and `expected`.

## Required evidence

- **Leak check.** The key and the query are absent from the message, from the JSON of every `Object.getOwnPropertyNames(error)` value, and from `inspect(error, { showHidden: true, depth: 20 })`.
  - A red case: an unscrubbed `evidence` fails this check.
- **Per message site.** Each of these turns red when its `scrub` is removed, and each red is recorded:
  - the class message;
  - the editor `seen`;
  - hints `:403`;
  - hints `:404-409`.
- **Readability.** The constraint-3 samples are readable after scrubbing, each with its own case.
- **One implementation.** `git grep` finds a single `scrub` and a single `redactSecrets`.
- **Commands.**
  - `pnpm lint:deps` passes, which shows the graph has no cycle.
  - `pnpm check` passes.
  - An exact-head local `pnpm test:stack` passes.

## Non-goals

- Product logging.
- Document Server logs.
- The external lane.
- #650 and #657.

## Review focus

- No raw value can be reached from a printed failure.
- Diagnostics stay readable.
- There is a single implementation.
- The import graph stays acyclic.
