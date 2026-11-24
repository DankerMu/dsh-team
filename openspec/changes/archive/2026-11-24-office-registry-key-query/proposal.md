# Office registry key query

## Why

Issue #660. Line numbers are on main `5102bbe`.

Two Office stack fixtures each carry their own copy of the same query: the keys that `registry.json` maps to a path.

- `office-editor-stack-fixture.ts:361-375` defines `KEYS`, which prints a list of keys, and `keysOf`, which maps unparseable output to `[]`. Its only caller is `distinctKeys` (`:379-398`).
- `office-forgotten-stack-fixture.ts:279-287` defines `REGISTRY_KEY`, which prints `{"key": first | null}`. Its caller is `registeredKey` (`:314-326`), which also requires `key !== ''`.

Both scripts have the same weaknesses:

- They catch every `OSError`/`ValueError` and never check `version`.
- A missing `entries`, a non-list `entries`, or a record without `key` raises a traceback.
- A record whose `entry` lacks `path` silently matches nothing.

No integration case runs either script against a real `registry.json`, so only `pnpm test:stack` exercises them. This breaks Code Canonicality.

`KEYS`'s comment says a registry can be "half written". It can't: the plugin writes a temporary file and renames it over `registry.json`, and never deletes it. Released `lib/index.js:1366-1384` is semantically identical to upstream `src/registry.ts:151-164`. The tarball's `src/registry.ts` is byte-identical to the one in `resource/`, and the `lib/index.js` sha256 equals the pinned `inputSha256`. A reader therefore sees either no file or a complete one.

## What Changes

- **One shared query.** `office-isolation-stack-fixture.ts` already exports `REGISTRY` (`:70`). Next to it, add the module-private script `REGISTRY_KEYS` and the exported function `registryKeys(lane, path): Promise<string[]>`. The function:
  - builds `['python3', '-I', '-c', REGISTRY_KEYS, REGISTRY, path]`;
  - runs it through `lane.exec`;
  - parses stdout strictly as a JSON list of non-empty strings and throws a fixed message otherwise.

  `distinctKeys` and `registeredKey` call only this function. `KEYS`, `keysOf` and `REGISTRY_KEY` are deleted.

- **Script contract.** The script validates every record before printing anything, then prints a single line.

  | Input                                                                                                                                        | Result                                                                                |
  | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
  | `FileNotFoundError`, including a missing parent directory                                                                                    | `[]` and exit 0 (not written yet)                                                     |
  | Any other `OSError` (permission, is-a-directory, …)                                                                                          | Fixed message `registry unreadable` on stderr, exit 2                                 |
  | Invalid JSON; top level not an object; `version != 1`; `entries` missing or not a list                                                       | Fixed message `registry format mismatch: <kind>` on stderr, exit 2, nothing on stdout |
  | A record that is not an object; `key` missing, not a string or empty; `entry` missing or not an object; `entry.path` missing or not a string | Same as above                                                                         |
  | Valid file                                                                                                                                   | The keys of the records whose `entry.path` equals the argument, in file order         |

  Every exception is caught and converted to one of these fixed messages, with no traceback. The script's own stdout and stderr never contain a key or a path.

  The upstream writer always writes `{version: 1, entries: [{key, entry, lastSeen}]}`, with `key` a 64-hex digest and an `entry` whose `path` is a string (`lib/index.js:2001-2009`). The #652 patch does not touch this code.

- **Callers.**
  - `distinctKeys` keeps its 5 s poll, the one-key-per-side rule and its redaction.
  - `registeredKey` takes `[0] ?? null` and keeps its 10 s poll. The empty-key guard moves into the strict parse.
  - A format failure rejects through `lane.exec` → `until` / `sessionFailure` and is never counted as zero keys.
- **Integration cases.** Each case uses real `python3 -I` against a real temporary `registry.json` that holds real-looking 64-hex keys, and states its expected result:
  - missing file;
  - missing parent directory;
  - an unreadable path (a directory);
  - a valid file with matching and non-matching paths and one path holding two keys;
  - every mismatch kind in the table above.

  The mismatch cases assert that stdout is empty and that stdout+stderr contain neither key text nor the path. Strict parsing of `registryKeys` is tested once, against stub exec output. Each caller gets one propagation case: a rejection is passed through, not turned into zero keys.

- The comment is corrected.

## Triage

```text
Issue type: test
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Office editor same-name and forgotten stack lanes; a wrong format rule fails both lanes on a valid registry; a lax rule silently counts zero
Selected risk packs: Error handling / rollback / partial outputs (missing vs unreadable vs malformed; fail loud); Auth / permissions / secrets (no key text in the query's own output); Config / project setup (plugin 0.2.0 registry format pinned)
Evidence floor: the design.md § Required evidence mutants red at the integration layer; pnpm check incl. duplicate-code; exact-head local pnpm test:stack green; exact-head VPS lane (repository gate, beyond the issue's AC5)
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the Office lanes read registry keys through one checked query.

## Impact

- `platform/test/office-isolation-stack-fixture.ts` (the shared query) and its integration test.
- `platform/test/office-editor-stack-fixture.ts` and `platform/test/office-forgotten-stack-fixture.ts`, and their integration tests.

No product, plugin or image change.
