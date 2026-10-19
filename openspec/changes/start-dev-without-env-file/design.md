# Design

Change surface: root `dev` package script and a small Bash foreground launcher; process-level regression and existing development guidance.

Must preserve: `pnpm build:web` before launch, Node24.13.1/pnpm10.34.6, native source/import watcher, Node dotenv syntax and inherited-env precedence, foreground signal settlement, production and `dev:bg` behavior.

Governing invariant: the launcher never hands a known-absent optional env path to the pinned native watcher, and otherwise delegates native startup unchanged.

## Decision

Use the existing root Bash-script convention. Start with Node's `--watch` argument; add native `--env-file=.env` only for an existing path (including a dangling symlink so malformed input is not silently ignored). Finish with `exec node` on the existing source entrypoint. Keep the build step in the root package command. A process probe showed the optional native flag also silently omits unreadable files, whereas the required native flag rejects them; the present-file branch deliberately uses the latter to preserve fail-loud configuration policy.

No shell sourcing, custom dotenv parser, placeholder file, Node upgrade, dependency or custom supervisor. Do not suppress FSWatcher errors. A concurrently removed file remains an explicit native startup error, not permission to retry or create it.

Native `--watch-path` is not selected: pinned CLI documentation supports it only on macOS/Windows, whereas Linux is a required environment. Programmatic dotenv loading would change CLI/Node-options and env-file watch semantics unnecessarily.

A file created after an env-less launch is loaded on the next explicit command start. This does not replace an existing working creation-watch behavior: the old command could not start in that state. Source reload remains native. Existing env-file changes retain native behavior; this change does not repair unrelated upstream env-value reload semantics.

## Verification

- Permanent process regression executes the actual package `dev` command in a temporary nonsecret fixture; only the unrelated web-build/application payload may be substituted to isolate native watch lifecycle. Observe successful child boot, source-change replacement identity, native env parsing/precedence and settled process ownership, not command text.
- Retain RED against the unmodified script; GREEN after the launcher change. Existing recorded Linux failure is ground truth, not a reason to rerun merely for confirmation.
- Parent-owned trusted smoke uses the genuine copied platform source/web build, real Docker prerequisite, fresh private SQLite, absent/present owned nonsecret env, HTTP health and observed restart. Do not read a developer env file or publish raw logs.
- Canonical scoped checks plus exact-reviewed-head trusted standalone Compose/full Docker and protected CI remain queue delivery gates.

Sibling surfaces: `start`, `dev:bg`, `dev:stop` and production source are intentionally unchanged; no new config input or lifecycle policy.

Review focus: absence versus invalid input; native parsing/precedence; actual reload and foreground cleanup; no real secrets or unrelated files touched; tests must not replace the watcher under test.

Human review: no production critical-path file is planned. A change to AGENTS development guidance is a rule-file change requiring explicit disclosure; no human signoff is claimed.
