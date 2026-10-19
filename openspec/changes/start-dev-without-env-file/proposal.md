# Optional environment files in development watch mode

## Why

Issue #174 records Node24.13.1's watch supervisor registering a missing optional `.env` and failing with FSWatcher ENOENT before platform health. The pinned upstream watcher unconditionally registers both required and optional env-file arguments. The application lifecycle is not the cause.

## What Changes

- Select the native Node watch invocation according to whether the root `.env` path exists, without creating a placeholder or parsing dotenv in shell.
- Preserve the real web build, native source reload, existing env parsing/precedence and foreground signal ownership.
- Verify the actual package command with isolated process fixtures, then real source-main health/reload on the trusted host. Explain the env-less launch boundary in existing development guidance.

## Capabilities

### Modified Capabilities

- `built-artifact-verification`: development watch startup and reload with optional environment input.

## Impact

Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent; expanded because this is a shared development entrypoint and configuration input.
Blast radius: foreground `pnpm dev` only; no production/background lifecycle changes.
Selected risk packs: CLI/script entry, config/setup, file IO, secrets, process ordering/settlement, compatibility, error handling, documentation.
Evidence floor: regression RED/GREEN, actual Node24.13.1/pnpm10.34.6 health and source reload for absent/present owned env files, clean owned processes, canonical checks/review/CI and exact-head trusted acceptance.
