# Stage 2 stale wording, comment arithmetic and Document Server name

## Why

Issue #666. Line numbers below refer to main `ffaa137`; the issue cited `be168db`.

- **A. Three `docs/DEPLOY.md` statements still say Office online editing is undelivered.** ONLYOFFICE ships in the user image (`images/dsh-user/Dockerfile`), the per-instance file token is specified (`openspec/specs/office-editing/spec.md`), and `docs/EMPLOYEE_GUIDE.md:7,38` describes the delivered behaviour. The guide covers the "off" case, and `openspec/specs/office-editing/spec.md:52-58` covers the "not connected" case. An operator reading the stale lines would conclude that editing and the cross-user file protection are unavailable:
  - `:212`: 「Office 在线编辑（第 18 组）上线之前，DOCX、PPTX 也都走这条路径」
  - `:275`: 「这项保护由第18组随 Office 在线编辑一起交付……在那之前实例内不启用 ONLYOFFICE，也没有经 Document Server 取文件的路径」
  - `:295`: 「Office 在线编辑（ONLYOFFICE 插件及其基于每实例文件令牌密钥的校验）尚未交付；该密钥本身已在每次启动时注入实例」
- **B. The stack `testTimeout` comment (`vitest.config.ts:49-90`) no longer adds up.**
  - The increment chain is correct: 2400 + 600 + 480 + 600 + 300 + 180 + 60 + 660 + 30 + 420 + 1500 + 960 + 870 = 9060 s, which matches `:91` `9_060_000`.
  - **B1.** The opening "leave 2880s" was last true at 4080 s. It should now be 9060 − 1200 = 7860 s.
  - **B2.** "That remainder is a margin, not the sum of every per-step bound" sits in the middle of the chain (`:59-61`), so the increments after it read as if they were outside the remainder.
  - **B3.** The idle lane line (`:64-65`) says "30s for the file's write and removal". Each of these is a separate `lane.exec` bounded at 30 s. Two more things on the same path are not counted:
    - the read before the edit and the read after close (`office-editor-stack-fixture.ts`), each a 30 s exec;
    - the Document Server readiness wait (`documentServerReady`, `office-hints-stack-fixture.ts:205-213`). Its deadline is 60 s, but it is checked only after each 30 s exec returns, so it is 60 s plus its last 30 s exec. The #649 line already states it this way.

    Measured on that basis, the per-step sum is 60 + 90 + 210 + 120 + 240 + 4×30 = 840 s, against the 660 s added. The overall margin covers the 180 s difference.
- **C.** `office-hints-stack-fixture.integration.test.ts:195` says "(nine-digit fraction)", but the sample `06:21:12.08079575Z` has eight digits. Docker's `StartedAt` uses RFC 3339 Nano, which allows up to nine digits and trims trailing zeros.
- **D. `'dsh-team-documentserver'` is defined in four places in `platform/test/`, plus three inline uses.**
  - Definitions:
    - `office-hints-stack-fixture.ts:24` `export const DOCUMENT_SERVER`;
    - `document-server-net-fixture.ts:13`, a private `const DOCUMENT_SERVER` next to its exported sibling `DOCUMENT_SERVER_NET`;
    - `deployment-document-server.docker.test.ts:21` `const DOCUMENT_SERVER`;
    - `container-document-server-fixture.ts:10` `export const DS_NAME`.
  - Inline: `deployment-fixture.ts:46,86` and `deployment.docker.test.ts:580`.
- **E. Duplicated cause text in `sessionFailure`.** `StackWorkbenchFailure` used to keep `cause` while also folding it into its message, so `sessionFailure` printed the cause twice. #663 (merged in `ffaa137`) now drops `cause`, which removes the duplication. What remains is the issue's acceptance criterion: an assertion that the cause text appears exactly once. The existing `toContain` assertions cannot catch a duplicate.

## What Changes

- **A.** Rewrite the three `docs/DEPLOY.md` statements as described in the issue. `:212` becomes a conditional: with Office online editing enabled and the Document Server connected, DOCX, XLSX and PPTX open in ONLYOFFICE; when it is off or not connected, DOCX and PPTX still take the WASM preview path. DOC and PPT are always converted in the instance. XLS, and XLSX when it is not opened in ONLYOFFICE, use the browser table view and are never converted in the instance; that sentence is narrowed to say so. This is consistent with `docs/EMPLOYEE_GUIDE.md:38`.
  - `:275` becomes 「跨用户取文件和回调由每实例文件令牌密钥阻止，这项保护随 Office 在线编辑交付，由跨用户攻击用例验证。」, without 「第18组」 or 「在那之前……」.
  - `:295` states that Office online editing is delivered, and drops 「尚未交付」 and the redundant key half-sentence.
  - `:121` 「（Office 在线编辑本身见 §7 末尾的交付状态）」 is kept, because after the `:295` change it points at the delivered statement.
- **B.** Rewrite the comment as a single ledger.
  - The base is 2400 s. Each lane's increment is listed in order and totals 9060 s, which is the 1200 s of cold builds plus 7860 s for everything else.
  - The margin sentence moves to the end of the ledger.
  - The idle lane line lists these bounds, each with a code location: the 60 s editor load, the 60 s Document Server healthcheck wait plus its last 30 s exec, the 210 s hold, the 120 s write-back, the 240 s idle-stop bound, and four 30 s execs (the write, two reads and the removal). It notes that they sum to 180 s more than the 660 s added, and that the margin covers the difference.
  - The end of the ledger says that polls bounded by a deadline (such as the 120 s write-back) can overrun by their last exec, and the margin covers that too. The two rewrite lines still count `documentServerReady` at its 60 s deadline only, in the older deadline-only notation.
  - The `testTimeout` value is unchanged.
- **C.** The comment becomes "(RFC 3339 Nano: up to nine fraction digits, trailing zeros trimmed; eight here)". The sample is unchanged.
- **D.**
  - `document-server-net-fixture.ts` exports `DOCUMENT_SERVER` next to `DOCUMENT_SERVER_NET`. This is the one definition.
  - `office-hints-stack-fixture.ts` stops defining it.
  - Every module that imported it from `office-hints-stack-fixture.ts` imports it from the net fixture instead (found by `git grep DOCUMENT_SERVER`, not a fixed list). This includes the stack fixtures, `platform-stack.stack.test.ts`, and `office-hints-stack-fixture.integration.test.ts`, whose pin `expect(DOCUMENT_SERVER).toBe('dsh-team-documentserver')` moves to the net fixture's own test.
  - `deployment-document-server.docker.test.ts`, `deployment-fixture.ts:46,86` and `deployment.docker.test.ts:580` import the constant instead of defining or inlining it.
  - `container-document-server-fixture.ts` keeps its exported name and becomes `import { DOCUMENT_SERVER as DS_NAME } from './document-server-net-fixture.ts'` plus `export { DS_NAME }`. The rename avoids the clash with the local `const DOCUMENT_SERVER` config object at `:14`, which stays as it is. Its consumers are the critical-path unit tests `platform/src/orchestrator/document-server.test.ts` and `document-server-retirement.test.ts`, which are not changed.
    - Accepted cost: through the net fixture, those two tests now also load `yaml`, `docker-cleanup.ts` and `docker-command.ts` at import time. This does not create a cycle; dependency-cruiser allows the edge and the net fixture's closure contains no office, container or deployment module.
  - Assertion and config-input literals stay as independent literals:
    - `office-hints-stack-fixture.integration.test.ts`, which asserts the constant's value and expected command arrays;
    - `deployment-setup-lifecycle.integration.test.ts:78,423`;
    - `document-server-net-fixture.integration.test.ts:315`;
    - `office-idle-stack-fixture.integration.test.ts:212`;
    - `document-server-startup.integration.test.ts:38`;
    - `admin-plugin-catalog.integration.test.ts:190`, a config input under test;
    - `platform/src/config.test.ts:415-418`.
- **E.** In `office-forgotten-stack-fixture.integration.test.ts`, the "attributes a failed reopen" case additionally asserts `expect(error.message.split(blocked.message)).toHaveLength(2)`, which means the message appears exactly once. All existing assertions stay.
  - **Red run:** temporarily restore `{ cause }` in `StackWorkbenchFailure`'s `super(...)` (`stack-browser-fixture.ts:138`), which is the pre-#663 shape. The new assertion fails with the message appearing twice. Then revert.
  - **Green:** passes on the branch.

## Triage

```text
Issue type: refactor
Fixture level: compact
Upstream suggested level: absent
Blast radius: operator documentation (DEPLOY.md); test-only constants and one test assertion; a comment; no product code, no timeout value, no critical path
Selected risk packs: Documentation / migration notes (DEPLOY.md statements, the timeout ledger)
Evidence floor: E red with `{ cause }` restored, then green; pnpm lint (lint:deps no cycle), pnpm dead-code, pnpm check; the ledger arithmetic recomputed in the PR body; reverse grep of the three docs; exact-head local pnpm test:stack (stack-verification evidence rule: Office stack fixtures and the stack test change imports); exact-head VPS lane (docker tests change imports)
```

design.md is omitted (compact). Two spec deltas are used, not one, because the change touches two capabilities: the deployment guide's Office statements (`deployment`) and the stack failure message (`stack-verification`).

## Capabilities

### Modified Capabilities

- `deployment`: the deployment guide states that Office editing and its per-instance file token protection are delivered.
- `stack-verification`: a stack session failure folds each cause exactly once.

## Impact

- `docs/DEPLOY.md`, `vitest.config.ts` (comment only).
- `platform/test/`: `document-server-net-fixture.ts`, `office-hints-stack-fixture.ts`, the stack fixtures importing the constant, `deployment-document-server.docker.test.ts`, `deployment-fixture.ts`, `deployment.docker.test.ts`, `container-document-server-fixture.ts`, plus the two test comments and the assertion.
- Out of scope:
  - every timeout value (#656);
  - the archived stage-2 `tasks.md`;
  - assertion and config-input literals;
  - product code, `deploy/` and critical paths.
