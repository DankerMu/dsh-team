# Load the duplicate-code gate's configuration

## Why

`pnpm duplicate-code` runs `jscpd platform --threshold …` without `--config`, and jscpd 5 only auto-discovers `.jscpd.json`, `.config/jscpd.json`, `.config/.jscpd.json` or a `jscpd` key in `package.json`. The root `jscpd.json` (formats `typescript`/`javascript`/`tsx`, `*.test.ts` ignored) has therefore never been read since 76070ce: the gate scans every format jscpd knows (css, python, markdown, sql, json, …) and counts test files, which is not what AGENTS.md, `constraints.yaml` and the guardrail self-test describe. Measured on #444's head: 478 files, typescript 3.09%, total 2.99% against the 3% gate; with the configuration applied, 210 files and 0.87% total. #445 would add the same route-test skeleton as #444 and trip the gate on test boilerplate the configuration excludes (#505).

## What Changes

- `package.json` `duplicate-code` passes `--config jscpd.json` explicitly; the file name and every documented reference stay.
- `jscpd.json` also ignores `**/*.test.tsx`: the existing `**/*.test.ts` entry never matched the nine `platform/web/src/*.test.tsx` files. With the configuration applied, tsx duplication was 2.87% (21 clones, essentially all in those files); those clones leave the metric by this decision. No `.test.js`/`.test.mjs` exists under `platform/`.
- Policy made explicit: `*.test.ts` and `*.test.tsx` files are excluded, as the configuration has said since 76070ce. Test-support modules under `platform/test/` (fixtures, fake daemons, `.mjs` hosts; about 112 files / 25.7k lines, roughly 64% of the remaining corpus) are not test files and remain in the metric.
- The guardrail duplicate canary (`scripts/test-guardrails.sh`) sizes its planted copies from the corpus the gate actually scans: same extension class, minus exactly the files `jscpd.json` ignores. Governing invariant: the canary-counted corpus is never smaller than the set jscpd scans. The planted copies, threshold and clean-tree acceptance are unchanged.
- AGENTS.md (Enforcement table row, the guardrail-canary paragraph, the Enforcement Index row) and `constraints.yaml` `enforced_by` say what is scanned.
- Threshold stays 3% in `constraints.yaml` (L3; out of scope). `.github/workflows/` text is unchanged; CI layer 4's `pnpm duplicate-code` step narrows its scan through this script change, which the PR states.

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: the root duplicate-code script is a shared gate entrypoint consumed by CI layer 4, pnpm anti-drift/check and the guardrail self-test, and the canary's corpus must stay a superset of the gate's scan — a sibling-surface invariant design.md pins)
Blast radius: a wrong edit either keeps counting tests (gate blocks #445 on boilerplate) or lets the canary count less than the gate scans (planted copies too small, gate silently weakened); both are caught by pnpm test:guardrails only if the corpus invariant holds
Selected risk packs: Config / project setup; Public API / CLI / script entry; Documentation
Evidence floor: pnpm duplicate-code loads jscpd.json (debug merged-config output or the run's own notice) and reports only the configured formats; pnpm test:guardrails accepts the clean tree and rejects the corpus-sized canary under Bash 3.2 and Bash 5 with equal N; canary file count ≥ jscpd's scanned file count; pnpm check
```
