# Design

## Change surface

`registryKeys` and `REGISTRY_KEYS` in `office-isolation-stack-fixture.ts`, the two callers that use them, and the integration cases.

## Must preserve

- `distinctKeys`:
  - its 5 s poll;
  - its rule of exactly one key per side;
  - `redactSecrets(failed, keys.flat())`;
  - `met.distinct`;
  - the `bothOpen` call at `office-editor-stack-fixture.ts:407`.
- `registeredKey`:
  - its 10 s poll;
  - the `null` it returns on timeout;
  - the forgotten lane's use of its key.
- The `openSides` stub and the `bothOpen` case at `office-editor-stack-fixture.integration.test.ts:205-237`. Their `JSON.stringify([key])` output is still valid under strict parsing.
- The other key-existence readers stay unchanged; they run a different query. Their format assumption agrees with the new rule:
  - `office-isolation-stack-fixture.ts:99`;
  - `office-profile-stack-fixture.ts:109`;
  - `onlyoffice-token-fixture.ts:55-60`.
- The 800-line limit.

## Governing invariant

- A missing registry means "not yet written", so polling continues.
- An unreadable or malformed registry fails loudly. The query's own output names only the failure kind.
- A valid registry yields exactly the keys whose `entry.path` equals the argument, in file order.
- The query is implemented exactly once.

## Decisions

- **Fail loud on mismatch, as the issue recommends.** The format rule covers every field the query depends on, plus the fields the writer always produces: `version`, `entries`, `key`, `entry` and `entry.path` (see the proposal's table).
- **Validate everything first, then print once.** So a mismatch never leaves partial stdout.
- **One exported function owns argv and strict parsing.** The callers only consume its result.

## Sibling surfaces

- The three key-existence readers listed under Must preserve.
- `docs/LOCAL_STACK.md` evidence fields do not change.

## Seams under test

- Real `python3 -I` with real temporary files, run by an integration helper that captures stdout, stderr and status (`spawnSync`).
- For strict parsing and caller propagation, stub `exec` output.

## Required evidence

Each mutant below must turn an integration case red; record each red.

- Remove the path filter.
- Change the output shape to `{key}`.
- Remove the `version` check.
- Remove the record `key` check.
- Remove the `entry.path` type check.
- Treat a non-`FileNotFoundError` `OSError` as `[]`.
- Restore a caller-side catch that turns a rejection or invalid output into `[]`.

Then the exact-head stack run must be green.

## Non-goals

- Product or plugin changes.
- The isolation lane's `retire` window, which the issue reports and leaves unfiled.

## Review focus

- The format rule matches what the plugin 0.2.0 release writes.
- No key text appears in the query's own output.
- There is a single implementation.
- Callers fail loudly and never count zero keys.
