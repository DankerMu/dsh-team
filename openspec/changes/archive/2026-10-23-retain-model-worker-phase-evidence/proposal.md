## Why

The restricted real-model worker (`platform/test/ci-vps-worker.ts`) runs checkout, install, build and the `pnpm test:model` driver under a one-shot authorization. Its `command()` helper throws a fixed string on any nonzero/error result and `executeAndRecord()` flattens every exception to `{exitCode: 1}`. The authorized #269 acceptance (invocation `cce7783b-a2cd-4f5d-9115-f04572c6957b`) therefore failed with no record of which preparation step failed or how; that historical cause stays UNKNOWN. A future authorization must not be consumed without leaving safe, bounded phase facts.

## What Changes

- Publish the current worker phase (`admission`, `checkout`, `install`, `build`, `driver`) to a private atomic receipt before each phase starts.
- On phase exit record only closed-set facts: exit status, signal, and failure category (`nonzero`, `signal`, `timeout`, `output-limit`, `spawn-error`, `identity-mismatch`, `admission-expired`, `unknown`).
- Carry the last phase and its failure category into the existing `execution.json`; `final.json` and the owner's host-receipt contract stay unchanged.
- Never persist raw command output, arguments, environment, error text, credentials or proxy values in these receipts.

## Impact

- Code: `platform/test/ci-vps-worker.ts`; new/updated integration regression exercising the real worker entry.
- Docs: `AGENTS.md` model-lane paragraph names the new private receipt.
- No change to authorization, admission, deadlines, cleanup, owner parsing, provider calls or GitHub channel.

## Triage

```text
Issue type: bugfix (verification diagnosability)
Fixture level: expanded
Upstream suggested level: absent (issue-scribe issue; expanded because it writes persisted private receipts consumed across a one-shot lifecycle and handles secret-adjacent process output)
Blast radius: a wrong receipt could leak model/proxy credentials into retained evidence, or break finalization/owner receipt parsing and strand the invocation lock.
Selected risk packs: File IO / path safety; Auth / permissions / secrets; Schema / field names; Error handling / partial outputs; Legacy compatibility; Documentation
Evidence floor: pnpm check:fast; pnpm test:integration <worker phase regression + existing ci-vps-owner/browser-build integration>; red-before/green-after for checkout/install/build failure attribution
```
