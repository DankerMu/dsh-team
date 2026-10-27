## Why

#373. On PR #371 the first exact-head full Docker run passed every test (33/33 files, 111/111) but custody reported cleanup `unconfirmed`: one shared-Engine submission (`f1e79366…`) stayed `submitted`. Its journal row and pending marker hold only `{version, id, state}` / `{version, id, invocation}`, so the operation and the test that issued it cannot be identified, and the daemon's event buffer had rolled over. The gate worked as designed; the evidence is just not attributable. The producer is either a Docker CLI mutation that did not exit 0, or an Engine HTTP mutation that failed outside the qualified rejection matrix, in both cases tolerated by its test (#373 correction comment).

## What Changes

- Shared-Engine submissions published through `beginVerificationSubmission(call)` — the Docker CLI wrapper (`scripts/docker-command.mjs`) and the tracked Engine HTTP client's default submit (`scripts/verification-submissions.mjs`) — record a `call` object in their journal `submitted` row:
  - `transport`: `cli` or `http`;
  - `operation`: CLI — a verb from a fixed enum, plus the subcommand for the `container`/`image`/`network`/`volume`/`compose`/`buildx` groups when that subcommand is itself in a fixed enum; otherwise `other`. HTTP — the method plus an endpoint template from a finite whitelist (resource segments shown as `{id}`, query dropped); otherwise `other`;
  - `caller`: the basename of the issuing test file, found from the stack (first `*.test.ts` frame under the repository's `platform/test/`; else the first frame there that is not a wrapper — `docker-command.ts`, `docker-cleanup.ts`); for the tracked HTTP client, a caller captured when the client is constructed is the fallback when the call-time stack has none (orchestrator promise queues drop async stacks); otherwise `unknown`. The parser accepts `^[a-z0-9][a-z0-9.-]*\.(ts|mts|mjs)$` or `unknown`.
- **Not labelled:** deployed-observer submissions (the main spec requires those per-request records to hold only opaque correlation identities, `trusted-docker-verification` "Deployed application observation is private and generation-bound"; they stay attributable through the observer generation in their marker), observer binding-approval/participant reservations (not Engine operations), browser exec rows (unchanged), and direct no-argument `beginVerificationSubmission()` calls (rows omit `call`; only verification fixtures call it that way).
- The label code and its validator live in `scripts/verification-submission-storage.mjs`, which every standalone bundle already ships, so no bundle list changes.
- The journal parser (`scripts/verification-submission-assessment.mjs`) accepts `submitted` rows with a valid `call` or without one (older journals stay readable) and rejects any other shape or value.
- No change to what settles a submission, to the qualified rejection matrix, or to the `unconfirmed` verdict.
- Step 2 of #373 (finding and making explicit the tests that tolerate failed mutations) moves to #374: it needs labelled recurrences to be more than guesswork.

## Triage

```text
Issue type: feature
Fixture level: expanded
Upstream suggested level: absent (changes a verification evidence format and its strict parser)
Blast radius: every trusted Docker custody run; a parser mistake turns every run unconfirmed (fails loudly) or, worse, accepts a malformed row; a label leak would put arguments or resource names into private evidence
Selected risk packs: Schema / columns / field names; Legacy compatibility / examples; Auth / permissions / secrets; Resource limits / large input / discovery; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: unit/integration tests for labelling, parser acceptance/rejection and leak negatives; pnpm check; exact-head VPS pnpm test:docker with confirmed cleanup and labelled rows; pnpm test:deploy
```
