## Risk packs

- **Public API / CLI / script entry — selected.** New `scripts/docs-only-diff.sh` contract (stdin paths, exit 0/1/2) consumed by `ci.yml`. Tasks 1.1, 1.2.
- **Config / project setup — selected.** The grammar is read from `constraints.yaml` `managed_archive_pattern`; a missing key is exit 2, not docs-only. Tasks 1.1, 1.3.
- **Error handling — selected.** Empty input, malformed config and an unreadable git range never yield `docs_only=true`. Tasks 1.1, 1.2, 1.3.
- **Legacy compatibility — selected.** Existing verdicts stay: `.md` outside `plugins/`/`images/` exempt, `plugins/`/`images/` Markdown and everything else not exempt; #644 replay unchanged. Task 1.3, 2.2.
- **Documentation — selected.** `scripts/README.md:90`, `constraints.yaml:246`. Task 1.4.
- **File IO / path safety — selected.** The script is a path classifier that decides a gate exemption: root anchoring, exact segment counts, nested and misnamed metadata rejected. Task 1.3 cases (nested archive path, `archive` name, `images/.../openspec/...`).
- **Not selected:** schema, auth/secrets (the job's token use is unchanged), concurrency, resource limits, release/packaging (no dependency).

## Must preserve

See `design.md`.

## 1. Implementation

- [x] 1.1 Move `yaml_get` from `.git-hooks/check-naming.sh` unchanged into `scripts/constraints-yaml.sh` (sourced, shellcheck-clean); the hook sources it and its diagnostics/exit codes/defaults stay identical (existing naming guardrail cases pass unchanged). Then `scripts/docs-only-diff.sh` per the design contract: bash, `set -u`, bash 3.2 compatible; sources the helper, reads `managed_archive_pattern` before classifying; archived form = 5 components + pattern; active form = 4 components, name ≠ `archive`, synthesized `archive/0000-00-00-<name>/.openspec.yaml` matches the pattern; no second copy of the grammar; exit 0 `docs-only`, exit 1 `evidence required: <path>|empty diff`, exit 2 on unreadable configuration.
- [x] 1.2 `.github/workflows/ci.yml` "Detect documentation-only change": keep `changed="$(git diff --no-renames --name-only "$RANGE")"`; pipe to the script; exit 0 → `docs_only=true` + log; exit 1 → no output; other exit → fail the step. Update the comment at lines 211-214 to name the metadata file. No other workflow change.
- [x] 1.3 `scripts/test-guardrails.sh`: accept and reject lists from `design.md` Required evidence, driven through `expect_accept`/`expect_reject` with the reason text; plus the configuration-failure case: `managed_archive_pattern` removed from the fixture `constraints.yaml`, input `docs/a.md`, assert exit code exactly 2 (a dedicated check, since `expect_reject` cannot tell 1 from 2) and stderr naming `managed_archive_pattern`. Red evidence: the accept cases fail against an old-rule (`.md` only) script; record the output.
- [x] 1.4 Docs (also add `scripts/constraints-yaml.sh` to the reader list in the `constraints.yaml:2-4` header): `scripts/README.md:90` and `constraints.yaml:246` state the rule (Markdown outside `plugins/`/`images/`, plus OpenSpec change metadata `.openspec.yaml` at `openspec/changes/<change>/` and `openspec/changes/archive/YYYY-MM-DD-<change>/`), naming the script.
- [x] 1.5 No existing guardrail case is removed or weakened (diff of `scripts/test-guardrails.sh` only adds cases; total count rises); the PR description states that `.github/workflows/ci.yml` changes.
- [x] 1.6 Workflow output hardening (round 1, S1): wrap every path-derived line the step prints (docs-only listing and `evidence required` reason) in `::stop-commands::<fresh random token>` … `::<token>::`; guardrail case runs the step's extracted `run:` text against a fixture repo containing `##[set-output name=docs_only;]true` + `platform/a.ts` and asserts no `docs_only` in `GITHUB_OUTPUT` and no unwrapped `##[`/`::` line; red with the wrapping removed.
- [x] 1.7 Ride-along (round 1 notes): replace the O(n²) `listing` concatenation with linear output; pin exit exactly 1 for the empty diff and one code path; add an invalid-regex exit-2 case.

## 2. Verification

- [x] 2.1 `pnpm lint:shell`, `pnpm lint:ci`, `pnpm lint:agents`, `pnpm lint:config`, `pnpm fmt:check`, `pnpm test:guardrails` (bash 3.2 on macOS) pass.
- [x] 2.2 Replays from `design.md`: #647 range (`b21fc5e...305df10`) exit 0; #644 range (`f481c0e9...d8588664`) exit 0; main-push range `b21fc5e..be168db` exit 0; this branch's range exit 1.
- [x] 2.3 `pnpm check`; exact-head VPS `pnpm test:docker` + `pnpm test:deploy` with confirmed cleanup (this diff contains code, so the gate still requires evidence); CI green, and this PR's "Detect documentation-only change" log shows no docs-only verdict.

## Non-goals

See `design.md`.
