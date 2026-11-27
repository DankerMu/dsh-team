## Risk packs

- **File IO / path safety (selected).** Relative resolution must keep the `isWithin` fence. Covered by tasks 1.2 and 1.3.
- **Release / packaging / dependency compatibility (selected).** The pinned patch output of `dsh-sidebar-onlyoffice@0.2.0` changes; a version or input mismatch still fails the build. Covered by tasks 1.1 and 2.2.
- **Legacy compatibility (selected).** Absolute paths from the file area behave as released, with the same document key. Covered by tasks 1.2 and 1.3.
- **Public API / script entry (selected).** The accepted `path` of the `config` and `watch` routes widens: session-relative was 400, now 200. Covered by task 1.2.
- **Error handling (selected).** Once joined to an absolute cwd, the `path must be absolute` 400 cannot occur; an empty `path` now answers 400 `unsupported extension ""`; a missing `path` keeps its 400. Covered by task 1.2.
- **Not selected:**
  - Auth / permissions / secrets: no token or trust check changes.
  - Concurrency: none.
  - Resource limits: path resolution adds no I/O or size dependence; the file size limit is unchanged.
  - Schema: none.
  - Config: none.
  - Documentation: none beyond the spec; the employee guide already says files open from the conversation.

## Must preserve

- Every existing onlyoffice and better-sidebar replacement, the version pin, the input SHA-256 values, and the refusal behavior of `patch-package.mjs`.
- The existing Office stack cases (#439, #649 and the others) and the Docker token test.

## 1. Implementation

- [x] 1.1 Add the two route-local replacements to `PINS.onlyoffice` in `images/dsh-user/patch-package.mjs` and update the `lib/index.js` output SHA-256. Unit tests pin the replacement count and that each original occurs exactly once in the released text, as the existing tests do. Add the behavioural unit tests from the design's required evidence, and record the red run against the released line.
- [x] 1.2 Docker test in the real user image covering the design's Docker cases on both `config` and `watch`: the four path cases, empty and missing `path`, and an equal key and claim path for the relative and absolute forms. Record the relative case's 400 on the pre-change image as the red run.
- [x] 1.3 Stack lane case: a scripted reply with the exact link `[工作通知.docx](工作通知.docx)`. Clicking it opens the editor, and the observed config request carried a non-absolute `path`, per the design's required evidence.

## 2. Verification

- [x] 2.1 `pnpm test`, `pnpm test:integration`, `pnpm lint` and `pnpm typecheck` exit 0 locally. `pnpm check:fast` and `pnpm test:guardrails` fail locally only on the untracked `.workplans/`; CI Fast checks and Guardrail self-test on the PR head are their evidence.
- [x] 2.2 Exact-head VPS `pnpm test:docker` and `pnpm test:deploy`.
- [x] 2.3 `pnpm test:stack` on the local lane with the new case.
