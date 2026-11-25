## Risk packs

- **Error handling / partial outputs — selected.** Every throw site is wrapped with phase and trace; the outermost error is a plain Error (Vitest flattens aggregates); `cause` keeps the original; the primary error stays first; the recorder uses `errorMonitor` only. Tasks 1.2, 1.3.
- **Concurrency / ordering — selected.** Attribution rests on the cross-end event order, so a shared `seq` counter is used instead of `ms`. The child exit is on the same timeline, and the shutdown escalation is distinguished. Tasks 1.1, 1.3.
- **Auth / secrets — selected.** The gateway session cookie travels on these requests. The trace records no headers, cookie or message text. Task 1.3 privacy assertion.
- **Resource limits / large input — selected.** Recording on a 200 MiB stream must stay O(1) per chunk: counters only. Task 2.1 runs the original RSS cases unchanged.
- **Not selected:**
  - public API / CLI: test-only code;
  - config, schema, file IO beyond the probe's own unlink inside the owned temp dir;
  - legacy compatibility;
  - release;
  - docs: platform/test/README.md does not describe this fixture's internals.

## Acceptance mapping (#250)

- **AC1** (attribute the close boundary of the failing transfer; when it does not reproduce, record the limitation): 1.1–1.3 make a future CI failure self-attributing. The PR and the issue comment state that the root cause remains unknown.
- **AC2** (if a defect is confirmed, add a regression and keep the three real-transfer and RSS controls): no defect is confirmed here. The three cases stay unchanged (2.1).
- **AC3** (the original `pnpm test:integration` and CI pass; the historical failure is kept): 2.1, 2.2. The issue stays open.

## Must preserve

See design.md § Must preserve.

## 1. Implementation

- [x] 1.1 Add `platform/test/gateway-stream-trace.ts`:
  - a trace recorder attached to a client request and response, and to an upstream request and response;
  - counters plus first-occurrence events;
  - a pure `firstClose`;
  - a JSON-safe summary.

  Add its unit or integration test.

- [x] 1.2 Wire the recorder into `transfer`, the client end, and `payloadResources.handler`, the upstream end. Add the `Gateway stream failure <json>` wrapper at every throw site of `runLargeTransfer`, with `cause` set to the original error and the `measured()` wrapper kept inside. Add fault knobs:
  - one that makes the upstream download pipeline reject after the response's `finish` (the CI signature);
  - one that makes the upstream destroy its incoming request after its first chunk;
  - for the SIGKILL and unlink probes, the existing `observe` hook is enough (design.md § Required evidence 2, 4).

  Record `escalated` in `shutdown()`. Scope the upstream trace to `/payload`.

  Keep `gateway-stream-fixture.ts` under 800 lines.

- [x] 1.3 Add `platform/test/gateway-stream-attribution.integration.test.ts` with the four probes and the privacy assertion from design.md § Required evidence. Each probe parses the JSON after the prefix and asserts the error is not an `AggregateError`. Show each probe red against the current source, then green.

## 2. Verification

- [x] 2.1 Run `pnpm test:integration platform/test/gateway-stream.integration.test.ts platform/test/gateway-stream-attribution.integration.test.ts` five consecutive times. Also run `pnpm test:integration`, `pnpm lint`, `pnpm typecheck` and `pnpm check`.
- [x] 2.2 PR carries `diff-limit-exempt` with the justification from proposal.md § Impact. Exact-head trusted VPS `pnpm test:docker` + `pnpm test:deploy`. Comment on #250 with what the next failure will report. Do not close #250.
