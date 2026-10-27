## Change surface

- `scripts/docker-command.mjs` `submission(execution)`: derives the CLI label from `execution.args`.
- `scripts/verification-submissions.mjs` `beginVerificationSubmission(call)` and `trackVerificationDockerClient(...).json`: derives the HTTP label from `method` and the query-stripped `endpoint` already computed there, and passes it to `submit(call)`.
- `scripts/verification-docker-generations.mjs` observer `submit(call)`: passes it through.
- `scripts/verification-submission-storage.mjs` `reserveSubmission(..., detail)`: already appends `detail` to the `submitted` row; the label goes there as `{ call }`.
- `scripts/verification-submission-assessment.mjs` `submissionFields` / `requireSubmissionTransition`: accept `call` on `submitted` rows that are not `browserExec`.
- One small shared module (or a section in `verification-submission-storage.mjs`) owns the label derivation and its validator, used by producers and the parser.

## Must preserve

- Settlement semantics: which outcomes settle, `client-closed-unknown`, the qualified rejection matrix, pending-marker lifecycle and fsync/close ordering (`trusted-docker-verification` spec, "Every shared-Engine producer has attributable submission evidence").
- Pending marker contents (unchanged; the label lives only in the journal row).
- `browserExec` submitted rows: exact key set unchanged.
- Journals written before this change (rows without `call`) still parse and assess identically.
- The 8 MiB journal bound (`readJournalText`); 2365 submissions × ~90 bytes stays far below it.
- No arguments, output, container/network/volume/image names or IDs, paths, environment, credentials or proxy values in the label.

## Must add / change

- `call` on every non-browser-exec `submitted` row from the three producers.
- Strict validation of `call` in the parser.

## Governing invariant

Every unresolved shared-Engine submission identifies which kind of operation and which test file issued it, and the evidence never contains anything outside fixed vocabularies and test file basenames.

## Sibling surfaces

- **CLI producers**: `platform/test/docker-command.ts` (sync/async, `acceptedStatus`), `scripts/probe-*.mjs`, `scripts/verify-browser-runtime.mjs`, `platform/test/ci-vps-worker.ts`. Outside `platform/test/` the caller is `unknown` (probes run as their own process).
- **HTTP producers**: `container-start-docker-fixture.ts`, `network-capacity.docker.test.ts`, `volumes-fixture.ts` (default submit) and deployed observers (`verification-docker-observer.mjs` → observer submit).
- **Parser consumers**: `readVerificationSubmissionsForCleanup`, `readVerificationWritersBeforeRetirement`, and the fresh-process assessment used by `pnpm verify:docker status`.
- **Bundled runtimes**: any standalone bundle that ships these scripts (check `scripts/` bundling for the restricted model worker and browser rescue) must include the new module.
- **Integration fixtures that write journals by hand** (`trusted-docker-audit.integration.test.ts` and friends): rows without `call` stay valid.

## Seams under test

- Pure label derivation (CLI args → label, method + endpoint → label, stack → caller) with a positive and leak-negative matrix.
- The real journal through `reserveSubmission` + `readVerificationSubmissionsForCleanup` in a temporary owned directory (existing integration patterns in `trusted-docker-audit.integration.test.ts`).
- The tracked HTTP client and CLI wrapper end to end with a controlled transport: an unsettled submission's row carries the right label.

## Non-goals

- No automatic settlement or retry of unresolved submissions; no relaxation of `unconfirmed`.
- No root-cause fix for the #371 run-1 event (unknown until a labelled recurrence).
- No change to pending markers, browser exec rows, or what counts as an observation.

## Review focus

1. No path from arguments, endpoints or stacks to anything outside the closed vocabularies (resource names that look like verbs, IDs in endpoints, absolute paths in stacks).
2. Parser strictness: old rows valid, new rows exact, anything else rejected; `browserExec` rows untouched.
3. Producers publish the label before dispatch and never let label derivation throw past the existing publication order (a derivation failure must fall back to `other`/`unknown`, not skip the submission).
4. Bundled-runtime completeness.
