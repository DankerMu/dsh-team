## Risk packs

- **Legacy compatibility (selected).** Keep the existing cases' facts, apart from `closedRewrote`, and keep the provider script indices (tasks 1.2, 1.3).
- **Concurrency/ordering (selected).** Save refusal and the close rewrite are measured (task 1.1).
- **Not selected:** schema, auth, security, resources, release.

## Acceptance mapping (#716 item 4)

- **Pinned new cases.** Both new cases pass, with facts pinned from two measurement runs (tasks 1.1, 1.2, 2.2).
- **Discrimination.** A flipped save outcome, forgotten copy or `closedRewrote` turns red (task 1.3).
- **PPTX digest residue.** It is resolved as the general fact `closedRewrote`: true in all 10 of #737's samples (task 1.2).

## Must preserve

- **Existing case expectations.** `clean`, `unsaved`, `xlsx`, `pptx` and `typing` keep every expected fact, except that the four rewrite cases add `closedRewrote: true`. DOCX `typed` facts stay the same under `heldApart`.
- **Provider scripts.** Indices 0–3 are unchanged; the new scripts go at 4 and 5. `rewriteLane` and the configured-scripts checks must match.
- **Spec scenarios.** These still hold, unless a MODIFIED delta is added under proposal § Spec:
  - every scenario of "Office 改写车道的提示条断言有区分力";
  - every scenario of "Office 改写车道覆盖 XLSX 与 PPTX";
  - every scenario of "The typing rewrite case holds a quiet window".
- **Lane rules.** The redaction, mask and fold-once rules still hold.

## 1. Implementation

- [x] 1.1 Measure.
  - Add the two cases with `waitSaveFailed: true`.
  - Add uncommitted instrumentation that prints `rewriteFacts`, the saved and closed digests, and the nonce reads for every case, and switch `:615` and `:617` to `expect.soft` for these runs only.
  - Run `pnpm test:stack` twice. Record the raw facts of both runs, and apply the stop rule.
  - Remove the instrumentation.
- [x] 1.2 Pin.
  - Set `saveRefused` per case.
  - Switch the typed check to `heldApart`.
  - Add `closedRewrote` to `rewriteFacts`: `true` for the four existing cases, measured for the new ones, `null` where the two runs disagree.
  - Pin `EXPECTED_REWRITE` and `MEASURED` for the new ids.
  - Move the hard-coded fours to six, and add the new ids to `officeRewriteLine` and its print test.
  - Update the provider script count, the ledger table, `Sum:` and `testTimeout`.
  - Update `docs/LOCAL_STACK.md` and `platform/test/README.md`.
  - Restate the two `b35c876` comments.
- [x] 1.3 Integration.
  - `measured()` and the stand-in key on `saveRefused` and `typeFirst`.
  - The shape comparison covers the new ids.
  - Add the mutants for the save outcome, the forgotten copy and `closedRewrote` (equal digests), each red against its pinned expectation.

## 2. Verification

- [x] 2.1 Run `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, `pnpm dead-code` and `pnpm duplicate-code`.
- [x] 2.2 Run one green `pnpm test:stack` on the final head, then the exact-head trusted VPS `pnpm test:docker` and `pnpm test:deploy`.
