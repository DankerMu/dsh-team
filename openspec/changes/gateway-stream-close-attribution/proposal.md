# Record which end closed first when a large transfer fails

## Why

Issue #250, reopened 2026-11-25. CI run 45403950277, attempt 1, job 138481475630 (PR #710), failed `gateway-stream.integration.test.ts` › "streams a complete 200MiB upload and download…" with a bare `Error: Premature close`. There was no stack, no phase and no endpoint facts, and attempt 2 passed. The original 2026-10 failure, in the buffer-upload control, looked the same. Twice now the failing transfer left nothing to attribute: which side closed first, how many bytes each side had moved, and how the gateway child ended.

The bare message narrows the site. `measured()` (`platform/test/gateway-stream-fixture.ts:280-378`) wraps every error raised during a direction as `Gateway stream child failure {direction, phase, pid, exitCode, signal, …}`. Vitest would print that with `Caused by:`, so the error escaped outside `measured()`.

Vitest 5.0.2 also replaces a thrown `AggregateError` with its `.errors` and drops the aggregate's own message. The `[1/1]` counter is the member count, so the CI line means exactly one member. That leaves two candidates:

1. `throw new AggregateError(cleanup, 'Gateway stream cleanup failed')` (`:690`) with a single tracked upstream pipeline error. Both directions and `stored()` had succeeded. The likely member is the upstream download `pipeline(source, response)` (`:550`) rejecting after the client had read the whole body and destroyed its request in `transfer`'s `finally`.
2. A bare throw from `stored()` (`:642`, rethrown through `preserve` at `:689`).

The multi-member `preserve()` and `withUpstream` aggregates are ruled out by `[1/1]`. Candidate 1 is a hypothesis, not a confirmed cause.

The issue's own next step is: "先让该文件在失败时记录：哪一端先关闭、已传输的字节数、子进程的退出状态，再等下一次复发来归因". This change does exactly that and nothing more. It does not claim a root cause, and it does not close #250.

## What Changes

- **Transfer trace.** Each transfer records non-sensitive lifecycle facts on both ends, with monotonic milliseconds from the transfer's start:
  - client: request bytes written, response bytes read, status code;
  - upstream: incoming bytes, outgoing bytes;
  - ordered first occurrences of finish/end/close/aborted events on the request, response and socket of each end;
  - Node error `code` and `name` only.

  No headers, cookies, URLs with credentials, bodies or error message text are recorded.

- **First close.** Events from both ends and the gateway child's `exit` share one `seq` counter, and order is decided by `seq`, not time. A pure summarizer returns one of:
  - `gateway`: the child ended abnormally without the shutdown escalation, whatever its `seq`;
  - `client` or `upstream`: the end with the earliest premature close;
  - `none`.
- **Every failure carries attribution, and the outermost error is never an `AggregateError`.** Vitest would otherwise print only the members. Any failure of `runLargeTransfer` throws a plain `Error` reporting:
  - the phase: `resources`, `upload`, `stored`, `download`, `upstream-cleanup`, `upstream-pipeline:<direction>` for a tracked pipeline that rejected, or `payload-cleanup` for temp-dir removal and its observer;
  - the trace of each transfer started so far;
  - the gateway child's exit code and signal for each direction.

  This includes the sites outside `measured()`. The original error stays reachable as `cause`, and error classes stay the same where a test depends on them.

- **Fault probes.** Real 200 MiB transfers are cut on purpose:
  - the CI signature: both directions and `stored()` succeed, and exactly one tracked upstream download pipeline rejects after the download response's `finish`;
  - the gateway child is SIGKILLed mid-upload;
  - the upstream destroys its incoming request mid-upload;
  - the stored file is removed before `stored()`.

  Each probe asserts the reported phase, the first-close end, partial byte counts and the child's ending.

Unchanged: the 200 MiB size, the 160 MiB RSS limit, the 30 s transfer / 45 s operation / 60 s test deadlines, all three acceptance assertions, no retry, no skip, no allowlist.

## Triage

```text
Issue type: test (diagnostics for an unattributed flake)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: the 200MiB gateway acceptance and its negative controls; a recorder that perturbs timing, leaks data, or swallows the original error would weaken the acceptance it diagnoses
Selected risk packs: Error handling / partial outputs; Concurrency / ordering; Auth / secrets (no credential-bearing fields); Resource limits / large input
Evidence floor: fault probes red before (bare or phase-less error) / green after; original 3 cases unchanged and green; 5 consecutive narrow runs; pnpm test:integration; pnpm check; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `gateway-routing`: a failed large-transfer acceptance names its phase, the first end to close, the bytes each end moved and how the gateway child ended.

## Impact

- The PR carries `diff-limit-exempt`. The fixture alone is about 250 lines; the trace module, its test, the wiring and the four probes come on top of that. There is no production change, and splitting would land a recorder without the probes that prove it.
- `platform/test/gateway-stream-fixture.ts`, which is at 692 of 800 lines. The trace recorder and summarizer go in a new sibling `platform/test/gateway-stream-trace.ts`.
- New probe cases in a new `platform/test/gateway-stream-attribution.integration.test.ts`. The original three cases in `gateway-stream.integration.test.ts` are not edited.
- No production gateway change.
