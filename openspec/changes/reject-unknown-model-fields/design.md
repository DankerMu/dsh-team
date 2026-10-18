# Design

## Context

The model descriptor currently rejects top-level unknown fields, while its raw validator delegates value checks to the shared settings parser. That parser projects model entries for both reads and writes. The published request and response schema already allow only name/contextWindow.

## Goals / Non-Goals

Invariant: an HTTP PUT with any unknown model-entry key cannot change settings or audit rows, and valid entries retain canonical value semantics.
Must preserve: current administrator/Origin/JSON admission, transaction reauthorization and audit rollback, key retention/redaction, response allowlist, default-model validation and save-time running count.
Non-goals: shared parser tightening, historical rewrite, new dependencies, GET413/415 cleanup, other settings changes, provider calls.

## Decisions

- Reject at the model descriptor's HTTP patch boundary, following its existing top-level rejection convention. Do not enable generic coercing/removing schema validation or change shared transport behavior.
- Derive entry-key authority from the existing schema properties rather than maintain a second field list. Inspect keys without duplicating name/contextWindow type or value validation; malformed shapes remain the canonical parser's responsibility.
- Check every model entry, including later entries and prototype-like own JSON keys. A known field alongside an unknown field still rejects the entire request.
- Keep storage parsing untouched: old rows with extra model keys remain readable through strict public projection and are not rewritten by GET.
- Existing request schema already matches the chosen rejection policy. Run the generator/check; any generated diff must come only from the generator, not hand edits.

## Risks / Trade-offs

- Clients relying on undocumented silent stripping now receive400 → document the existing strict contract and prove no partial update or credential echo.
- Moving the check into storage would break legacy reads → HTTP-only enforcement and a real stored-extra-field read regression.

## Verification and Rollback

Use the existing HTTP fixture to save known settings, submit contextwindow typo with secret-bearing data, and compare complete persisted settings/audit rows. Verify valid name/contextWindow values, top-level rejection, array/null/value-domain behavior and prototype-like keys. Smoke source/dist over real TCP/file SQLite and reopen; preserve existing security tests. Rollback is prior application code with no data conversion, restoring its schema/runtime mismatch.
Parent owns this single mapped implementation/fixture audit under higher-priority delegation rules; independent risk-scaled cross-review remains separate.
