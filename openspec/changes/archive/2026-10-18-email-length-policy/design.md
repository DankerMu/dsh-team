# Design

## Context

See proposal.md. Authentication already normalizes before route validation; all HTTP registration/login and administrator CLI inputs use that function. Audit persistence also receives stored identities directly, so input validation alone is insufficient.

## Goals / Non-Goals

Governing invariant: new account emails and new audit actor/target emails contain at most 254 Unicode code points; historical audit evidence is never rewritten.
Must preserve: exact identities, account IDs, password encoding and policy, sessions, event metadata, current transaction rollback, query ordering and authority checks.
Non-goals: source-address bounds, rate-limit or retention changes, email syntax redesign, automatic repair, historical audit cleanup, provider calls, or host maintenance.

## Decisions

- Count after trim/lowercase for new authentication input. Existing safe `Invalid email` rejection remains sufficient; HTTP responds400 before hashing, throttling or audit writes, CLI rejects before prompting or opening storage.
- Extract the existing bounded password code-point scan into one allocation-free shared primitive. Preserve surrogate-pair and isolated-surrogate semantics, early overflow exit and password6..256 behavior.
- Keep the persistent email bound in the database module's public API so auth and audit share it without an auth/audit dependency cycle. Do not impose authentication syntax on audit metadata; optional NULL and bounded empty strings remain supported.
- Audit persistence rejects either over-limit email before INSERT, with a fixed error that never echoes metadata. Existing enclosing transactions provide rollback; no truncation or silent omission.
- Check existing users through an iterator and the same length predicate after migrations, before capacity validation, Docker reconciliation and listening. Check active and disabled accounts. SQL `length(TEXT)` alone is unsuitable because embedded NUL terminates its count.
- Fail startup with a fixed actionable compatibility error, preserving database rows and closing the handle through existing shutdown ownership. Historical audit overflow alone never blocks startup. CLI input remains bounded but does not gain a global compatibility scan.
- Keep the existing audit HTTP raw-query `maxLength:254` boundary. Installed Ajv counts Unicode code points, not UTF-16 units. Canonical254 astral filters work already; event/time queries expose historical over-limit metadata verbatim. No schema change is required for this filter.

## Risks / Trade-offs

- Existing over-limit accounts block all platform availability → explicit user-approved upgrade policy, preflight/remediation documentation and source/built refusal evidence.
- Lowercasing may expand Unicode text → tests measure the normalized result, not input length.
- Shared counting refactor could alter password identity → preserve UTF-16LE derivation and run existing surrogate/boundary regressions.
- Historical audit data remains large → deliberate compatibility choice, no claim of reclaiming existing space.
- No observed production inventory → do not assume compatible data; operator owns offline correction.

## Migration Plan

Stop the platform and back up its database before upgrade. Inspect existing account identities using the documented Unicode rule, correct offending accounts offline while preserving their IDs and uniqueness, then restart. Never rewrite historical audit identities to follow renamed accounts. This change has no schema migration; rollback restores the previous application and its unbounded-input risk, not a data conversion.

## Required Evidence and Review

Use real HTTP plus SQLite to prove boundary acceptance, overflow rejection with unchanged rows, historical browsing and exact filters; direct audit tests cover both email fields and rollback. Actual source and compiled entrypoints must reject incompatible file-backed accounts before contacting an owned socket, without modifying user/session/audit rows. Review normalization order, all audit producers, startup ordering, Unicode/NUL edge cases and unchanged password behavior.
Workflow deviation: higher-priority single-slice delegation rules require parent-owned fixture review and implementation; independent multi-seat cross-review remains delegated in separate worktrees.
