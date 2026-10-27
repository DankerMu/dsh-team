## Why

#373. On PR #371 the first exact-head full Docker run passed every test (33/33 files, 111/111) but custody reported cleanup `unconfirmed`: one shared-Engine submission (`f1e79366…`) stayed `submitted`. Its journal row and pending marker hold only `{version, id, state}` / `{version, id, invocation}`, so the operation and the test that issued it cannot be identified, and the daemon's event buffer had rolled over. The gate worked as designed; the evidence is just not attributable. The producer is either a Docker CLI mutation that did not exit 0, or an Engine HTTP mutation that failed outside the qualified rejection matrix, in both cases tolerated by its test (#373 correction comment).

## What Changes

- Every shared-Engine submission's journal `submitted` row gains a `call` object with three closed-set, non-sensitive fields:
  - `transport`: `cli` or `http`;
  - `operation`: for CLI, a verb from a fixed enum (with the subcommand for `container`/`image`/`network`/`volume`/`compose`/`buildx` groups when it is itself in the enum), else `other`; for HTTP, the method plus an endpoint template whose resource segments are replaced by `{id}` (for example `POST /containers/{id}/kill`), else `other`;
  - `caller`: the basename of the first stack frame under the repository's `platform/test/` (for example `container-start-docker-fixture.ts`), else `unknown`.
- Producers covered: the CLI wrapper (`scripts/docker-command.mjs`), the tracked HTTP client with the default submit (`scripts/verification-submissions.mjs`), and the observer submit (`scripts/verification-docker-generations.mjs`). Contained browser exec keeps its existing `browserExec` row shape unchanged.
- The journal parser (`scripts/verification-submission-assessment.mjs`) accepts the row with or without `call` (older journals stay readable), and rejects any other shape, value outside the closed sets, or extra key.
- No change to what settles a submission, to the qualified rejection matrix, or to the `unconfirmed` verdict.
- Audit (report only): list tests that tolerate a mutating CLI non-zero exit or a non-qualified HTTP error without rethrowing; the PR body reports them. Behaviour changes there are out of scope unless a call site is unambiguously wrong, and then only with its own test.

## Triage

```text
Issue type: feature
Fixture level: expanded
Upstream suggested level: absent (changes a verification evidence format and its strict parser)
Blast radius: every trusted Docker custody run; a parser mistake turns every run unconfirmed (fails loudly) or, worse, accepts a malformed row; a label leak would put arguments or resource names into private evidence
Selected risk packs: Schema / columns / field names; Legacy compatibility / examples; Auth / permissions / secrets; Resource limits / large input / discovery; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: unit/integration tests for labelling, parser acceptance/rejection and leak negatives; pnpm check; exact-head VPS pnpm test:docker with confirmed cleanup and labelled rows; pnpm test:deploy
```
