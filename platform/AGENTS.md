# platform/AGENTS.md

> TypeScript and test-discipline detail for `platform/` and, later, `plugins/`.
> The root `AGENTS.md` is the operating contract; this file extends it and never overrides it.

## TypeScript rules

- **Node runs the sources directly.** Relative imports carry the `.ts` extension; type-only imports use `import type`. Enums, namespaces, and constructor parameter properties are rejected by `erasableSyntaxOnly` because Node cannot strip them.
- **Browser sources live in `platform/web/src/`.** They use the workspace's strict DOM/TSX tsconfig and cannot import backend, tests, plugins, server libraries or Node builtins. Backend source serves only the built artifacts.
- **`tsconfig.json` strictness is deliberate**: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Relaxing a flag needs a justification in the PR description.
- **No `any`** — use `unknown` and narrow. **No `@ts-ignore`**; `@ts-expect-error` only with an explanation.
- **A cast (`as`) needs a comment** saying why the compiler cannot know what you know.
- **Named exports only.** A module's `index.ts` exports its public API and nothing else; it is the only file other modules import.
- **Validate at boundaries, trust types inside.** Parse and validate environment variables, HTTP input, DSH responses, RAGFlow responses, and Docker API responses where they enter; do not re-validate typed values between functions of the same process.
- **Configuration is explicit.** Deployment-varying values are fields of `PlatformConfig` (`platform/src/config.ts`), validated at startup. No `process.env` reads outside that file.

## Test-Driven Development

The test is the specification. Write the test before the implementation; if the test cannot be written, the requirement is not yet clear enough to implement.

### Cadence

1. **Red** — write the smallest failing test for the next bit of behaviour. Run it. Confirm it fails for the right reason.
2. **Green** — write the minimum code that makes it pass.
3. **Refactor** — with tests green, clean up names, structure, duplication. Run the tests again.
4. **Commit** — at green-and-clean points.

### Structure

- Test names are sentences describing behaviour: `rejects port "0"`, `answers 404 for an unknown route`.
- Three blocks per test, separated by blank lines: arrange, act, assert. One concept per test.
- Unit tests sit next to the source: `src/foo.ts` → `src/foo.test.ts`. Tests that bind a port or touch a real database go in `platform/test/*.integration.test.ts`; tests that start a real container go in `platform/test/*.docker.test.ts`.
- Unit tests of `db`, audit, auth, app, CLI, gateway and admin routes may use isolated in-memory SQLite (`:memory:`) and never a file-backed database. Exact allowances and `openDatabase` rules: `platform/test/README.md` § Test placement.

Gateway unit tests may use the same isolated in-memory database through `buildApp` to exercise real session admission and failure responses; real TCP and upgrade EOF/peer-abort tests remain integration tests. No gateway unit test opens a file-backed database.

- Browser cases: `platform/test/*.ui.test.ts` behind `pnpm test:ui` (real Vite build, owned TCP/SQLite, screenshots, zero console errors).
- Real Docker cases: only `platform/test/*.docker.test.ts` behind `pnpm test:docker` on giap-vps; ordinary integration discovery excludes them; every owned cleanup runs in `finally` and its errors fail the command.
- Real-provider cases: only `platform/test/*.model.test.ts` behind `pnpm test:model` on giap-vps; credentials never reach assertion diffs or diagnostics.
- Full placement rules for admin routes, web static routes, CI evidence helpers, Docker and model cases: `platform/test/README.md` § Test placement.

### What gets tested

- Every public function with non-trivial behaviour, every branch, and the error paths — a test that only shows "no exception thrown" is incomplete.
- Boundary conditions: empty input, maximum input, zero, negative, off-by-one.
- Every external boundary (HTTP route, DSH call, Docker call, RAGFlow call) has at least one integration test against the real thing or a local instance of it.

### What does not need a test

- Pure wiring with no branch, type-only files (`types.ts`, `*.types.ts`), and `index.ts` files that only re-export.
- `platform/src/main.ts`, the process entry point; `pnpm e2e` exercises it.
- `platform/web/src/main.tsx` only while it remains pure declarative bootstrap; its actual React rendering is checked by `pnpm test:ui`.
  This one exact exemption is registered in `constraints.yaml`; all future client behavior TS/TSX files require sibling unit tests and the unchanged per-file coverage floor.

Administrator CLI behavior is not a process-entry exemption: `cli.ts`, terminal interaction, identity policy and administrator service keep sibling unit tests; PTY process tests run in `platform/test/cli.integration.test.ts` behind `pnpm test:cli` (`platform/test/README.md` § Test placement).

### Isolation and flakiness

- Tests share no mutable state and do not depend on order. Each integration test binds port 0 and closes what it opens.
- A flaky test is a bug: quarantine it with a linked issue, fix or delete it within 7 days.

### Forbidden

- Disabling a test to make CI pass; `it.skip` without a linked issue and a deadline.
- Mocking the system under test. Mock its dependencies.
- A test added only to raise coverage, with no assertion about behaviour.

## Code conventions

### Coverage threshold

- Minimum 80% lines, branches, functions, and statements **per file** (`vitest.config.ts`, value from `constraints.yaml`). A well-covered large file must not subsidize a bare one.
- Read an uncovered line as a dead-code candidate first and a missing test second: delete the line or test the behaviour.
- Every coverage exclusion is registered with a reason in `constraints.yaml` `exemptions`.

### Debt markers

- `FIXME` blocks the next release; `TODO` is fixed as soon as resources allow; `XXX` is lowest priority, no commitment.

### Deviations carry reasons

- Every non-default configuration value — a rule switched off, a timeout, an exclusion — carries an inline comment naming its motivating failure mode.
- An empty catch names what it swallows and why; keep the guarded block to the one statement that can throw.
