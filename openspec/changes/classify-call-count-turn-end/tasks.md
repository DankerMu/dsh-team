## 1. Turn-end classification on call-count failure

- [ ] 1.1 RED: in `platform/test/permission-model.integration.test.ts`, update the existing "diagnoses $starts starts and $calls calls" cases to expect the four-field detail. Their fixture keeps its single `turn/end` `{kind:'completed'}`; count its assistant messages from the fixture.

  Add cases built from `bashEvidence()` with no `assistant/attempt` events, so `permission-provider-attempt` cannot pre-empt the branch:
  - zero calls, `turn/end` `{kind:'completed'}`, one assistant message → `turn-start:1,tool-call:0,turn-end:completed,assistant-message:1`;
  - zero calls, `turn/end` `{kind:'error', error:{message:<sentinel>, code:<sentinel>}}`, no assistant message → `...,turn-end:error,assistant-message:0`;
  - zero calls, `{kind:'aborted', reason:{kind:'hook', reason:<sentinel>}}` → `turn-end:aborted`;
  - zero calls, `{kind:'max-tokens'}` → `turn-end:max-tokens`;
  - zero calls, `{kind:'blocked'}` → `turn-end:blocked`;
  - zero calls, `{kind:'interrupted'}` → `turn-end:other`;
  - zero calls, `{kind:<sentinel string>}` → `turn-end:other`;
  - zero calls, no `turn/end` → `turn-end:absent`;
  - zero calls, two `turn/end` → `turn-end:multiple`;
  - zero calls, a `turn/end` whose `turn` differs from the `turn/start` turn → its kind is still reported (pins the no-turn-binding rule);
  - two calls → `tool-call:2` with the turn-end kind;
  - zero calls, a `turn/end` with no `data.reason`, and one whose `reason` is a non-object (a string sentinel) → both give `permission-turn-call-count` with `turn-end:other`. The shape must not turn the classified failure into `unclassified`.

  Each case asserts that the whole `permissionFailure(...)` output `toEqual`s the expected object, so no sentinel (error message or code, hook reason, raw kind) can appear. Observe RED on the current oracle.

- [ ] 1.2 GREEN: in `platform/test/permission-model-oracle.ts`, compute the two facts only inside the `starts.length !== 1 || calls.length !== 1` branch of `toolIdentity`, from the same filtered `events`.
  - Map the kind through a fixed allowlist.
  - Read `data.reason.kind` with non-throwing type checks, not `record()`, which throws on non-objects (`container-start-docker-fixture.ts:15-17`). Any failed check maps to `other`.
  - Do not change the success path, the `provider-attempt` check and its position before `toolIdentity`, any other code, or `permissionFailure`.
- [ ] 1.3 Run `pnpm test:integration platform/test/permission-model.integration.test.ts`; expect exit 0 with all cases passing. Run `pnpm check:fast`; expect exit 0.

## 2. Delivery

- [ ] 2.1 Review, CI, trusted exact-head Docker/deploy evidence, merge. The real-model run requires separate SHA-bound authorization and is not part of this change.

## Risk packs

- **Auth / permissions / secrets — selected.** The detail reaches `failure.json` and the Actions log via the thrown message (`deployment-isolation.model.test.ts:228-233,256-258`). It carries only closed-set kinds and integers, never tool names, arguments, content, error message or code, hook reasons, or the raw kind. The sentinel cases in 1.1 prove this.
- **Error handling / partial outputs — selected.** A missing, duplicate or mismatched `turn/end` must not throw a different error or mask the primary code. It yields `absent`, `multiple` or the reported kind under the same `permission-turn-call-count` code (1.1). The `provider-attempt` precedence is preserved (1.2).
- Not selected, because this is a test-oracle failure detail with no production, configuration or format change: Public API / CLI; Config; File IO; Schema; Concurrency; Resource limits; Legacy; Release; Documentation.
- **Non-goals:**
  - This does not establish the historical cause of #332 or of the #241 failures.
  - The prompt and probe bytes stay unchanged; rewording or splitting the probe is a user decision.
  - No retry or relaxed acceptance.
  - No real-model call.
  - `absent` is defensive: the Yolo case waits for `turn/end` before reading history (`deployment-isolation.model.test.ts:151-162`).

The rc.2 kinds come from `resource/deepseek-harness` tag `dsh-v0.2.0-rc.2`, `packages/core/session/src/types.ts` `TurnEndReasonMap`. This is the version the image installs (`images/dsh-user/Dockerfile:7`).
