# Design: docs-only classification of OpenSpec change metadata

Change surface: new `scripts/docs-only-diff.sh`; new shared helper `scripts/constraints-yaml.sh` (the `yaml_get` moved out of `.git-hooks/check-naming.sh`, which sources it); `.github/workflows/ci.yml` step "Detect documentation-only change" (lines 215-230); `scripts/test-guardrails.sh` (new cases); `scripts/README.md:90`; `constraints.yaml:246` (`verification.docker_ci_evidence.evidence`).

Script contract (`scripts/docs-only-diff.sh`, bash, shellcheck-clean, no Node/pnpm: it runs before `pnpm/action-setup` and `setup-node`):

- Input: newline-separated repository-relative paths on stdin (the exact `git diff --no-renames --name-only` output; blank lines ignored).
- Exit 0 and print `docs-only` plus the path list when the input is non-empty and every path is documentation.
- Exit 1 and print a reason naming the first offending path (`evidence required: <path>`), or `evidence required: empty diff` for empty input.
- Exit 2 when its own configuration cannot be read (e.g. `managed_archive_pattern` missing from `constraints.yaml`); the workflow treats any exit other than 0/1 as a job failure, never as docs-only.
- A path is documentation when it ends in `.md` and is not under `plugins/` or `images/`; or it is exactly an OpenSpec change metadata file, anchored at the repository root:
  - archived form: exactly five `/`-separated components `openspec/changes/archive/<dated>/.openspec.yaml` AND the whole path matches `managed_archive_pattern` (the pattern alone is too wide: its tail `/[^/]+(/[^/]+)*$` also matches nested files, so the component count is checked first);
  - active form: exactly four components `openspec/changes/<name>/.openspec.yaml`, `<name>` is not `archive`, and the synthesized path `openspec/changes/archive/0000-00-00-<name>/.openspec.yaml` matches `managed_archive_pattern`. This applies the name grammar without writing a second regex.
- Grammar extraction stays single: `.git-hooks/check-naming.sh`'s `yaml_get` (lines 21-45) moves unchanged into a shared sourced helper `scripts/constraints-yaml.sh`; the hook and the new script both source it. The hook's diagnostics (`check-naming.sh: ... source: ...` lines), exit codes and fallback defaults stay byte-identical (canonicality-archive-policy spec). No copy of the sed pipeline or of the date/name grammar is added.
- Configuration is read before any path is classified, so a missing `managed_archive_pattern` exits 2 even for an all-Markdown input.

Workflow: `changed="$(git diff --no-renames --name-only "$RANGE")"` stays; the step pipes it to the script; exit 0 writes `docs_only=true` to `$GITHUB_OUTPUT` and logs the script output; exit 1 leaves the output unset; any other exit fails the step. The RANGE expression, step ids, `if:` conditions and later steps are unchanged.

Must preserve: `.md` outside `plugins/`/`images/` is still docs-only; `plugins/**` and `images/**` (including their Markdown) still require evidence; empty diff still requires evidence; an unreadable range still fails the job; PR and main-push ranges share one rule; the job still succeeds (never "skipped") for docs-only so the aggregator is unaffected; `pnpm verify:docker-evidence` and the exact-head/tree-equivalent reuse rules are untouched; no label-based exemption.

Governing invariant: a diff is exempt from trusted Docker evidence only if every changed path is one the Docker suites can neither build nor run; the only non-Markdown addition is the OpenSpec CLI's change metadata file at its two exact locations.

Sibling surfaces: `.git-hooks/check-naming.sh` (now sources `scripts/constraints-yaml.sh`; behavior unchanged, proven by the existing naming guardrail cases); `ci.yml` PR range and main-push range (one step, both ranges); `scripts/README.md:90` and `constraints.yaml:246` (descriptions); `constraints.yaml:82` `managed_archive_pattern` (grammar source, also read by `.git-hooks/check-naming.sh:40-44,97` — must stay unchanged); `scripts/test-guardrails.sh:136` (`.openspec.yaml` naming-hook fixture, unrelated, unchanged); `lockfile-consistency` job (separate rule, out of scope).

Seams under test: the script as invoked with stdin (guardrail cases); the workflow step text (review + this PR's actual CI log); replay of real ranges.

Required evidence:

- Accept (exit 0): `openspec/changes/archive/2026-11-20-stage-2-dsh-ragflow-office/.openspec.yaml` + `openspec/changes/stage-2-dsh-ragflow-office/.openspec.yaml` + archived `.md` files; `openspec/changes/foo-bar/.openspec.yaml` + `openspec/changes/foo-bar/proposal.md`; plain `docs/X.md`.
- Reject (exit 1, reason names the path): `plugins/x/README.md`; `openspec/changes/archive/2026-11-20-foo/specs/.openspec.yaml` (nested under an archive dir — the managed pattern alone matches it); `openspec/changes/archive/.openspec.yaml` (name `archive`); `images/dsh-user/openspec/changes/foo/.openspec.yaml` (root anchoring); `images/dsh-user/x.md`; `openspec/config.yaml`; `openspec/changes/foo/fixture.yaml`; `openspec/changes/archive/2026-1-1-x/.openspec.yaml`; `docs/.openspec.yaml`; `openspec/changes/foo/specs/.openspec.yaml` (nested); `openspec/changes/Foo/.openspec.yaml` (bad name); a mixed list `docs/a.md` + `platform/src/x.ts`; empty input (`empty diff`).
- Configuration failure: with `managed_archive_pattern` removed from a fixture `constraints.yaml`, input `docs/a.md` (which would otherwise be docs-only) → exit exactly 2 and stderr names `managed_archive_pattern`; never exit 0.
- Red: the accept cases fail against a script implementing only the old `.md` rule.
- Replay: `git diff --no-renames --name-only b21fc5e...305df10 | bash scripts/docs-only-diff.sh` → exit 0; `git diff --no-renames --name-only f481c0e9...d8588664 | bash scripts/docs-only-diff.sh` → exit 0 (unchanged verdict); main-push two-dot range `git diff --no-renames --name-only b21fc5e..be168db | bash scripts/docs-only-diff.sh` → exit 0 (its only non-Markdown paths are #647's two `.openspec.yaml`); this PR's own range → exit 1.

Non-goals: exempting `openspec/**` wholesale or `openspec/config.yaml`; changing `pnpm verify:docker-evidence`; label exemptions; touching `plugins/`/`images/` rules; changing `managed_archive_pattern`.

Review focus: (1) pattern cannot match anything but the two exact metadata locations; (2) script failure (exit ≥2, missing constraints) can never produce `docs_only=true`; (3) grammar is read from `constraints.yaml`, not duplicated; (4) both ranges still go through the same code; (5) bash 3.2 (macOS guardrail run) and bash 5 compatibility.
