## ADDED Requirements

### Requirement: Duplicate-code gate scans its configured scope

The root `duplicate-code` command MUST load the repository's `jscpd.json` explicitly and MUST scan only the formats it configures (`typescript`, `javascript`, `tsx`) under `platform/`, excluding `*.test.ts` and `*.test.tsx` files; test-support modules under `platform/test/` remain in scope. The threshold MUST continue to come from `constraints.yaml` through `scripts/constraints.mjs`. The guardrail self-test's duplicate canary MUST size its planted copies from a corpus that is never smaller than the set the gate scans, dropping exactly the files `jscpd.json` ignores, so that rejection remains proven against the gate's real corpus.

#### Scenario: Configuration is loaded

- **WHEN** `pnpm duplicate-code` runs on the clean tree
- **THEN** the configuration is read from `jscpd.json`, the format table lists only the configured formats, no `*.test.ts` or `*.test.tsx` file appears among the clones, and the command exits zero

#### Scenario: Canary still rejects after the scope change

- **WHEN** the guardrail self-test plants two identical corpus-sized functions under `platform/src/`
- **THEN** `pnpm duplicate-code` rejects with the configured threshold, the planted size is computed from the ts/js/tsx files `jscpd.json` does not ignore (a file count at least the gate's), and the result is identical under Bash 3.2 and Bash 5
