# Keep the verify-browser-runtime case failure across its cleanup

## Why

Issue #722. Line numbers refer to main `a4efa57`.

1. Every case in `platform/test/verify-browser-runtime.integration.test.ts` (`:183-185`, `:208-210`, `:239-241`, `:264-266`, `:288-290`) runs `killStandIn(run.root)` and then `rm(run.root, …)` in a bare `finally`. If either one rejects, its error replaces the case's own failure. This is the same class of bug as #662 (`dev-watch`'s `rm(root)`).
2. The comment at `platform/test/browser-build-fixture.ts:129` says "anything else is reported as is". That is not what happens: a non-ESRCH kill error thrown from `retireDescendants` is caught by `caseSpawn` (`trusted-docker-fixture.ts:220-226`) and reported as `unobservable (<name>)`.

## What Changes

- **Shared cleanup step.** The five cases share one cleanup step that follows #662's `withWatch` shape:
  - run the stand-in kill and the tree removal, each in its own `try`;
  - collect each failure as a labelled residual (`kill: <error>`, `rm: <error>`);
  - when the case failed, append `; cleanup: <residual>` to the case's own `Error` and rethrow that same error;
  - when the case passed but cleanup failed, throw the residual.
- **Regression rows** (tasks.md 1.2), each recorded red before the guard and green after:
  - the case fails and the removal rejects;
  - the case fails and the stand-in kill rejects, so `rm` must still run;
  - the case passes and the removal rejects.

- **Comment fix.** The comment at `browser-build-fixture.ts:129` is reworded to match the behavior: other kill errors propagate to `caseSpawn`, which names only their kind.

`design.md` is omitted: compact fixture, test-only.

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent
Blast radius: verify-browser-runtime wrapper cases; a wrong cleanup could leak a held stand-in process or a temp tree, or still mask a case failure
Selected risk packs: Error handling / partial outputs (primary failure preserved, cleanup residual attached)
Evidence floor: regression case red before / green after; the file's existing cases green; pnpm test:integration; pnpm lint; exact-head VPS lane
```

## Capabilities

### Modified Capabilities

- `built-artifact-verification`: browser-runtime wrapper case cleanup keeps the case failure and labels its residual.

## Impact

- `platform/test/verify-browser-runtime.integration.test.ts`
- `platform/test/browser-build-fixture.ts` (comment only)
