# Design

## Context

See proposal.md for motivation. `scripts/probe-browser-native.mjs` is the canonical process-birth/liveness adapter. Linux reads `/proc/<pid>/stat`; Darwin currently hashes `ps` display text. Browser receipts and external rescue compare those identities to determine whether a driver/producer can still own resources. Native same-process cleanup already has issued `ChildProcess` capabilities, which must not be replaced by weaker external observations.

The installed Darwin `proc_bsdinfo` ABI supplies process ID, status and kernel start time in seconds plus microseconds through `proc_pidinfo(PROC_PIDTBSDINFO)`. A read-only local qualification returned the complete136-byte structure and exact observing process ID. The SDK declares this interface but warns that libproc interfaces are subject to change; exact structure/result validation is mandatory. This is primitive availability evidence, not completed regression or cleanup acceptance.

## Goals / Non-Goals

Goal: one canonical, stable Darwin generation observation with explicit old-receipt refusal before cleanup authority is derived. Preserve Linux semantics and all existing ownership fences.

Non-goals: broad process supervision, automatic recovery/adoption, changing execution deadlines, widening Docker deletion authority, provider calls, changing production images or modifying the pending #274 command design.

## Decisions

### SDK-declared kernel birth fields rather than command display

Use Darwin's SDK-declared process-info ABI through a bounded isolated Python3 standard-library ctypes observer. Read only process ID, status and microsecond start time. Validate exact structure length, returned PID, numeric domains and known states; only a zero native return with ESRCH establishes process absence. Short returns, unknown errno, interpreter failure, permission failures and malformed output remain unknown. Keep the existing observation deadline and bound the tiny protocol output. Do not emit command text, environment or arbitrary native errors.

Python3 is already a repository verification prerequisite; document its Darwin native-process role. No package dependency or compiled addon is introduced. Inline the small adapter within the canonical module so existing standalone copied module closures remain complete. The Linux branch does not spawn Python and retains its current identity representation and errors.

Use an explicitly distinguishable Darwin birth representation based on PID and kernel start timeval. Reject the previous display-hash representation instead of silently reinterpreting it. A stable command snapshot, sleep, repeated polling, or seconds-only start time would retain races or weaken generation separation. Undeclared unique-ID flavors are not used; the installed declared ABI supplies precise birth information and must be qualified by actual exec-transition evidence.

### Reject obsolete authority before liveness inference

Apply a canonical format/compatibility fence at receipt consumption and any external identity comparison not dominated by that boundary. A pre-change Darwin identity cannot become evidence that a driver or producer is dead, even if its PID currently does not exist. Preserve receipt bytes and private resource paths. Do not update persisted authority based on a current observation. In-memory issued native child ownership and its `creator` capability token retain their existing exact checks; this change does not enable external Darwin native signalling.

### Separate fixture ownership from canonical identity

Regression fixtures own direct child handles, settle each independently and preserve original scenario failures alongside cleanup errors. External process-group signalling still requires captured generation and fresh group verification. Leader disappearance alone is not group-absence evidence. The pending #274 fixture repair must not conceal canonical helper defects.

## Verification

Use one vertical RED/GREEN slice at a time. First prove real same-process identity across an acknowledged command change and distinct observer locale/timezone. Then prove real old-receipt rescue refusal with an untouched sentinel and no external mutation. Exercise absence, unknown observation and Linux behavior through existing process-boundary consumers. Run actual smoke observers separately from permanent tests, then the scoped/full integration consumers and exact reviewed-head trusted Docker command with independent resource/host checks. No model invocation is authorized by this change.

## Risks / Trade-offs

- Native ABI or Python unavailability → explicit unsupported observation, never fallback to display hashes.
- Old outstanding receipts cannot be automatically rescued → retain them for explicit operator resolution; no compatibility alias or inferred adoption.
- A process may exit during observation → only exact absence may mean absent; all other failures retain unknown authority.
- Same-UID hostile mutation is outside existing trust assumptions → retain existing private-file and immutable-resource checks rather than claiming a stronger security boundary.

## Migration Plan

Land the canonical repair independently before resuming #274. Do not replace code under an active verification owner. New invocations publish only the new Darwin representation; old receipt consumers refuse. Rollback requires settling new invocations first and retaining unresolved receipts, not translating them into the previous representation. Linux deployments keep the same wire identity.
