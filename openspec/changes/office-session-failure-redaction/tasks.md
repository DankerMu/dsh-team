## Risk packs

- **Auth / permissions / secrets — selected.** Covers document keys and query tokens. Tasks 1.1–1.4.
- **Error handling / rollback / partial outputs — selected.** A failure still names its phase and cause chain. Tasks 1.1, 1.4.
- **Documentation / migration notes — not selected.** The PR states the class contract change.
- **Not selected:** product, concurrency, config.

## Acceptance-criteria mapping (#663)

- **AC1** (stand-in editor, rewrite and hints failures leak no key or query in the message, cause chain or any own property) → 1.1, 1.4.
- **AC2** (editor `seen` and hints `:403` / `:404-409` are scrubbed, each with a red-on-unscrub case) → 1.2, 1.3, 1.4.
- **AC3** (one `scrub`; forgotten and rewrite use it) → 1.1.
- **AC4** (`officeEditorLine` and `officeRewriteLine` unchanged) → 2.1. The forgotten alert-text change is accepted (design.md).

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [ ] 1.1 Shared code in `stack-browser-fixture.ts`:
  - Move `redactSecrets` and `Secrets` here, and update every importer.
  - Export `scrub` within the design.md rule constraints.
  - Change `StackWorkbenchFailure` so that it folds the scrubbed cause chain into its message, sets no `cause`, and stores `evidence` already scrubbed.
  - Delete the forgotten and rewrite copies of `scrub`. In `sessionFailure`, scrub each part before joining.
- [ ] 1.2 Editor lane: scrub each element of `seen`.
- [ ] 1.3 Hints lane: scrub `:403`, and make `:404-409` match a scrubbed projection.
- [ ] 1.4 Add the cases listed in design.md § Seams under test and § Required evidence:
  - leak checks over all own properties plus `inspect(showHidden)`, including the red case for unscrubbed evidence;
  - lane drivers through the `vi.mock` seam, the editor one through `AggregateError` or `retiringOnError`;
  - the hints matcher diff;
  - a red-on-unscrub run for each message site, recorded;
  - the readability samples.

  Update only the assertions listed in design.md, and list them in the PR.

## 2. Verification

- [ ] 2.1 The existing success-line tests pass unchanged. Run the touched integration files three times in a row, then `pnpm lint` (including `lint:deps`), `pnpm typecheck`, `pnpm duplicate-code` and `pnpm check`. If the diff is over 400 lines, label it `diff-limit-exempt` and state why in the PR.
- [ ] 2.2 Exact-head local `pnpm test:stack`.
- [ ] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`.
