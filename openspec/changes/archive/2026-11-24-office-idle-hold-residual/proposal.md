# Office idle hold residual

## Why

This change is slice C2 of #657. The Office idle lane's hold (`heldRunning`, `platform/test/office-idle-stack-fixture.ts:83-101`) asserts that A stays running for 210 s at one idle minute while A's workbench and its DOCX editor are open. The issue asked whether the editor is what keeps A alive, and required a measurement before deciding.

### Measurement (local `pnpm test:stack`, main `4813e2f` plus a throwaway probe, 2026-11-23)

The probe was never committed.

- **Setup:** after the lane's editor session closed, and before `idleRetired`, a second workbench-only session ran. It opened no file, and the idle minutes were still 1. It held A for 210 s (`holdMs: 210001`).
- **Result:** A was `running` at the start and still `running` at the end:
  - `restarted: false`;
  - `idleStops: 0`;
  - 0 connections under `/sidebar/onlyoffice/ds` during the hold.
- **The workbench's own connections**, all opened at load and still open at the end:
  - two WebSockets, `/api/remote.mux` and `/sidebar/ws`;
  - one SSE, `/plugins/events`;
  - 210 `/sidebar/api` fetches during the hold (about one per second).
- **Gateway accounting:** each of these is a tracked live connection or an activity refresh (`platform/src/gateway/routes.ts:103`, `:188`; `connections.ts`).
- **Stack outcome:** the run passed. `idleRetired` still idle-stopped A after the control browser closed. The inventory was unchanged apart from the authorised `ragflow-cpu` restart; `VOL-SAME`.

So the workbench alone keeps A running. The hold proves that "the workbench with an open editor is not reclaimed", not that "the editor keeps A alive".

### Decision (user, 2026-11-23)

Record this as an accepted residual. Do not restrict the browser's routes to the editor's connections. In the product, the editor is always embedded in the workbench.

## What Changes

- **Spec:** `stack-verification` records the residual and its measurement.
- **Docs:** `docs/LOCAL_STACK.md:200` cites the measurement in place of "保活来自哪个连接不在本车道判定".
- **Unchanged:** test code, `vitest.config.ts`, and product code. No stack budget changes.

## Triage

```text
Issue type: test (accepted residual, docs/spec only)
Fixture level: compact
Upstream suggested level: absent
Blast radius: none at runtime; documentation of what the idle lane proves
Selected risk packs: none
Evidence floor: the measurement above (local stack exit 0, probe JSON); docs-only diff (scripts/docs-only-diff.sh)
```

## Capabilities

### Modified Capabilities

- `stack-verification`: the Office idle lane's hold is documented as not attributing the keep-alive to the editor.

## Impact

- `docs/LOCAL_STACK.md:200`
- `openspec/changes/office-idle-hold-residual/`

## Acceptance-criteria mapping (#657 C2)

- **"Record the control's result in tasks.md or the evidence"** → the Measurement section above and task 1.1.
- **"Tighten the assertion by the result, or record it as an accepted residual confirmed by the user"** → the Decision above, plus tasks 1.2 and 1.3.
- The PR says `Refs #657`. Slice A (A1–A4) remains.
