## 1. Residual

- [x] 1.1 Measure the workbench-only control. Result: A held running, with no DS connection; see the proposal's Measurement section.
- [x] 1.2 The user accepted the result as a residual (2026-11-23).
- [x] 1.3 Record it in the `stack-verification` delta and `docs/LOCAL_STACK.md:200`.

## 2. Verification

- [x] 2.1 `openspec validate office-idle-hold-residual --strict --no-interactive`
- [x] 2.2 `scripts/docs-only-diff.sh` classifies the diff as docs-only, so no trusted Docker evidence is required.
