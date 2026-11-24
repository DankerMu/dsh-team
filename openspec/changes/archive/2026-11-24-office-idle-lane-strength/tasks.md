## Risk packs

- **Concurrency / shared state / ordering — selected.** The font check runs before the idle change. Task 1.2.
- **Error handling / rollback / partial outputs — selected.** The restore runs on success, and `retiringOnError` is kept. Task 1.1.
- **Config / project setup — selected.** `runtime-config` equals its snapshot after the lane. Task 1.1.
- **Not selected:**
  - product code;
  - secrets (the five runtime-config fields are non-secret, and only equality is recorded);
  - release.

## Acceptance-criteria mapping (#657, slice C)

- **C1** (dropping the restore, or deleting the success-path call, fails a layer) → 1.1, 1.3.
- **C3** (swapping the font check and the idle change fails an integration case) → 1.2, 1.3.
- **Shared AC** (red→green per new assertion; nothing lengthened, skipped or removed; exact-head `pnpm test:stack`) → 2.1–2.3.
- **C2** → its own later slice (see proposal). Slice A follows #652. The PR says `Refs #657`.

## Must preserve

See `design.md` § Must preserve.

## 1. Implementation

- [x] 1.1 C1:
  - `officeIdleScenario(lane, body = officeIdle)`: snapshot `runtime-config` before, then read back and deep-compare after its restore, recording `restored: true`.
  - Integration cases:
    - C1-a: `loaded`'s success path, with a stand-in hold and a recording admin, leaves a restore that PUTs the original configuration.
    - C1-b: `officeIdleScenario` with a stand-in body calls the body-assigned restore exactly once on success.
- [x] 1.2 C3:
  - Export `loaded(admin, email, operator, idle, readFonts, hold = heldRunning)` (`officeIdle` passes `() => editorFontNames(editor)`), returning `{ fonts, hold }`, and use it from `officeIdle`.
  - Integration case: when `fontsShown` fails, zero PUTs are made and the restore stays the no-op.
- [x] 1.3 Show red, then green:
  - the `:187` restore dropped;
  - the `:212` call deleted;
  - `:186` and `:187` swapped.
- [x] 1.4 Evidence:
  - add `restored` to `officeIdleLine`;
  - update the integration test `:162-186`;
  - update `docs/LOCAL_STACK.md:199`, adding `restored`, keeping the existing fields and the 210 s argument, and correcting "只开着 DOCX 编辑器" (the workbench is also open; C2 is a later slice).

## 2. Verification

- [x] 2.1 `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [x] 2.2 Exact-head local `pnpm test:stack`, green with `restored: true`, and the inventory/volume fence passes.
- [x] 2.3 Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy` with confirmed cleanup. It does not run the stack fixtures. CI requires it anyway: `All checks passed` depends on `pnpm verify:docker-evidence`, which needs the exact-head `dsh-team/docker` status for every non-docs-only PR (`scripts/README.md:88`; #664).
