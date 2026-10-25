## Why

The real Yolo isolation case has failed at `native-probe-2/oracle permission-turn-call-count` twice: invocation `38616f12` (PR #241) and invocation `377e875f`, which recorded `turn-start:1,tool-call:0` (#332). One run in between passed with no prompt or probe change.

In rc.2 a retried provider failure leaves an `assistant/attempt` event, which already triggers `permission-provider-attempt` before the call-count check (`permission-model-oracle.ts:261`). The #332 code therefore already partly excludes a retried provider error. It still cannot distinguish:

- the model replying without calling the tool (for example a refusal of the probe-2 script);
- the output budget running out (`max-tokens`);
- a cancelled turn (`aborted`);
- a terminal turn error.

The reply text is withheld by design, so a further authorized run would add no information.

## What Changes

When the call-count check fails, the `permission-turn-call-count` detail gains two locally computed facts over the events with `seq > afterSeq` (the cursor captured before the prompt was sent):

- `turn-end:<kind>`. With exactly one `turn/end`, its `reason.kind` maps to the closed set `completed|error|aborted|blocked|max-tokens`. Any other rc.2 kind (`interrupted`, `forked`) or unrecognised value maps to `other`. Zero `turn/end` events give `absent`; more than one gives `multiple`. The raw value is never echoed.
- `assistant-message:<n>`: the count of `assistant/message` events in that same window.

Neither fact is filtered by turn id. That matches how the oracle already selects events, and a `turn/end` whose `turn` differs from the `turn/start` is still reported by its kind.

The resulting detail is `turn-start:<n>,tool-call:<n>,turn-end:<kind>,assistant-message:<n>`.

The following stay unchanged:

- every acceptance criterion: exactly one turn/start and exactly one tool/call are still required;
- the `provider-attempt` check, which still runs before `toolIdentity`;
- every other failure code, the success path and the `permissionFailure` contract;
- the prompt, the probe bytes, the timeouts and the model.

## Triage

```text
Issue type: test
Fixture level: compact (Auth/secrets pack selected for the no-content diagnostics contract; the change is confined to one oracle failure branch in test code, with no production, entrypoint or format change)
Upstream suggested level: absent
Blast radius: real-model verification receipts; a wrong change could leak conversation/error/hook content into retained evidence and Actions logs, or loosen the unique-call oracle
Selected risk packs: Auth / permissions / secrets; Error handling / rollback / partial outputs
Evidence floor: pnpm test:integration platform/test/permission-model.integration.test.ts (RED then GREEN), pnpm check:fast
```

`design.md` is omitted at the compact level.

## Impact

- `platform/test/permission-model-oracle.ts`: the failure branch of `toolIdentity`.
- `platform/test/permission-model.integration.test.ts`: the count-diagnostic cases.
- **Detail consumers.** `platform/test/deployment-isolation.model.test.ts:228-233,256-258` writes the detail into `failure.json` `primary.detail` and into the thrown `detail=...` message, which reaches the Actions logs. These are the public surfaces the no-content contract protects.
- **Not a consumer.** `platform/test/permission-model-fixture.mjs:213` persists only the code, never the detail. Its write path, used by `managed-model.model.test.ts`, shares the same oracle branch, so a call-count failure there also carries the four-field detail in its thrown error.
- There is no other reader in `scripts/`, `*.docker.test.ts` or `*.model.test.ts`.
- There is no `platform/src/`, prompt, probe, workflow or Docker case change.
