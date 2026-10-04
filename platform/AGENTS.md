# platform/AGENTS.md

> TypeScript and test-discipline detail for `platform/` and, later, `plugins/`.
> The root `AGENTS.md` is the operating contract; this file extends it and never overrides it.

## TypeScript rules

- **Node runs the sources directly.** Relative imports carry the `.ts` extension; type-only imports use `import type`. Enums, namespaces, and constructor parameter properties are rejected by `erasableSyntaxOnly` because Node cannot strip them.
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
- Unit tests sit next to the source: `src/foo.ts` → `src/foo.test.ts`. Tests that bind a port, start a container, or touch a real database go in `platform/test/*.integration.test.ts`. The `db` module is the exception: its unit tests may use in-memory SQLite (`:memory:`); file-backed SQLite stays in `platform/test/*.integration.test.ts`. App unit tests may inject that same in-memory handle through `buildApp` to verify real app-owned handle lifetime rather than mock-forwarding; they still must not open a file-backed database. `openDatabase` rejects a filename that the SQLite driver would trim, keeps exact `:memory:`, follows a symlink to the real regular file for WAL/SHM permissions, and rejects a directory (direct or via symlink) without changing its mode.

### What gets tested

- Every public function with non-trivial behaviour, every branch, and the error paths — a test that only shows "no exception thrown" is incomplete.
- Boundary conditions: empty input, maximum input, zero, negative, off-by-one.
- Every external boundary (HTTP route, DSH call, Docker call, RAGFlow call) has at least one integration test against the real thing or a local instance of it.

### What does not need a test

- Pure wiring with no branch, type-only files (`types.ts`, `*.types.ts`), and `index.ts` files that only re-export.
- `platform/src/main.ts`, the process entry point; `pnpm e2e` exercises it.

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
