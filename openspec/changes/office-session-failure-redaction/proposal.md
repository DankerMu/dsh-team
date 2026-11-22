# Office session failure redaction

## Why

Issue #663. Line numbers are on main `be3ddfa`.

When an Office stack lane fails, its browser session evidence is printed raw. That evidence includes the Document Server socket path `/doc/<64-hex key>/c/` and full URLs with their queries. A document key is the capability for its editing session. AGENTS.md § Observability and `platform/test/README.md` forbid keys in evidence, and failure output is exactly what gets pasted into PRs and issues.

The raw output escapes through two routes.

**`StackWorkbenchFailure`** (`stack-browser-fixture.ts:66-79`) keeps:

- the original failure as `cause`;
- an enumerable `evidence` own property.

Its `failedRequests` entries are `${method} ${full url}` (`:214`), and vitest prints both cause chains and own properties. The editor, rewrite and hints lanes let this error escape unchanged:

- `office-editor-stack-fixture.ts:343`;
- `office-rewrite-stack-fixture.ts:474`, `:605`;
- `office-hints-stack-fixture.ts:393`.

Only the forgotten lane wraps it, in `sessionFailure` (`office-forgotten-stack-fixture.ts:391-407`).

**Assertion messages and diffs:**

- The editor's `seen` (`:344`) joins raw `consoleErrors` and pathname-only ≥400 responses. A pathname still carries the key.
- The hints lane joins raw `consoleErrors` into an assertion message (`:403`).
- The hints lane runs `toMatchObject` against the raw `browser` (`:404-409`), and a failed match prints the full `failedRequests` URLs in its diff.

**Canonicality.** There are two `scrub` implementations:

- forgotten `:384`: a known key plus any 64-hex run;
- rewrite `:269`: query/hash removal plus any 20+-character run that is not all lowercase.

## What Changes

- **One redaction implementation.** `redactSecrets` and its `Secrets` type move, unchanged, from `office-isolation-stack-fixture.ts:261` into `stack-browser-fixture.ts`, which keeps the dependency graph acyclic. Every importer is updated, with no re-export.
- **A shared `scrub(text, secrets = [])`** is exported next to it. It replaces both existing copies, forgotten `:384` and rewrite `:269`. design.md § Decisions sets the constraints on its rule. Briefly: it removes known secrets, 64-hex keys and URL queries, and keeps failure diagnostics readable.
  - It is applied per list element and per cause message, never to a serialized JSON blob.
- **`StackWorkbenchFailure` is safe by default.**
  - The message folds in the scrubbed cause chain: each message scrubbed, joined with `<-`, at most 8 levels deep. It keeps the existing label and counts prefix.
  - The error no longer sets `cause`.
  - `evidence` stays an ordinary `readonly` own property, but its lists are scrubbed when the error is constructed.
  - vitest 5 prints all own properties (`Object.getOwnPropertyNames`), including non-enumerable ones, so scrubbing at construction is what makes this safe.
- **Editor lane:** `seen` (`:344`) scrubs each console error and each response path.
- **Hints lane:**
  - `:403` uses scrubbed `consoleErrors`.
  - `:404-409` matches a scrubbed projection of `browser`, with each list mapped through `scrub`, so a failing diff's message, `actual` and `expected` hold only scrubbed values.
- **Forgotten lane:** `sessionFailure` keeps its label and `scene`, now scrubs each part before joining, and uses the shared `scrub(text, [kA ?? undefined])`.
- **Excluded: `office-external-stack-fixture.ts:198-205`.** The external lane opens no Document Server session, so no `/doc/<key>/` path or session key can appear there. Its raw lists remain, out of scope.

## Triage

```text
Issue type: bugfix (test secret hygiene)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: every stack lane's failure message (StackWorkbenchFailure is shared by all workbench sessions); Office lanes' assertion messages; success evidence lines must stay unchanged
Selected risk packs: Auth / permissions / secrets (document keys and query tokens in failure output); Error handling / rollback / partial outputs (failure must still name its phase and cause chain); Documentation / migration notes (none beyond PR)
Evidence floor: see design.md § Required evidence; pnpm check incl. lint:deps; exact-head local pnpm test:stack and VPS lane
```

## Capabilities

### Modified Capabilities

- `stack-verification`: Office stack failures carry no document key or query token.

## Impact

- `platform/test/stack-browser-fixture.ts`
- `platform/test/office-editor-stack-fixture.ts`
- `platform/test/office-rewrite-stack-fixture.ts`
- `platform/test/office-hints-stack-fixture.ts`
- `platform/test/office-forgotten-stack-fixture.ts`
- `platform/test/office-isolation-stack-fixture.ts` and `office-profile-stack-fixture.ts`: the `redactSecrets` import moves
- the integration tests of these fixtures

No product code changes.
