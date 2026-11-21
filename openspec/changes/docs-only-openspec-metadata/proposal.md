# Classify OpenSpec change metadata as documentation in the docs-only exemption

## Why

The docker-evidence job exempts a diff from trusted Docker evidence only when every changed path ends in `.md` and none is under `plugins/` or `images/` (`.github/workflows/ci.yml:222-226`, introduced by 9ec6df9). `openspec new change` writes and `openspec archive` moves a two-line metadata file `.openspec.yaml` (`schema: spec-driven` / `created: <date>`) inside the change directory. No code, image, Dockerfile or Docker suite reads it (`git grep -e "openspec/changes" -e "\.openspec" -- 'platform/**/*.ts' 'scripts/**' 'images/**' '**/Dockerfile*' .github` only hits prose and the naming-hook fixture). So every spec-only proposal or archive PR that carries the file is treated as code and must buy a full exact-head VPS lane (≈1.5 h): #647 needed one, while #643/#644 passed only because their change directories happened to lack the file (#664).

## What Changes

- The docs-only classification moves out of inline workflow bash into `scripts/docs-only-diff.sh`, which reads the changed-path list on stdin and decides. `ci.yml` keeps computing `$changed` with `git diff --no-renames --name-only "$RANGE"` for both PR (`base...HEAD`) and main-push (`before..after`) ranges and calls the script.
- Besides `*.md` outside `plugins/` and `images/`, the script accepts exactly the OpenSpec change metadata file: `openspec/changes/<change>/.openspec.yaml` and `openspec/changes/archive/YYYY-MM-DD-<change>/.openspec.yaml`, with the date and name grammar taken from `constraints.yaml` `code_canonicality.scratchpad_directories.managed_archive_pattern` (#199), not re-authored.
- Everything else keeps the evidence requirement: any other path, anything under `plugins/` or `images/`, and the empty diff.
- `pnpm test:guardrails` drives the script directly with accept and reject lists.
- `scripts/README.md:90` and `constraints.yaml:246` describe the rule.
- `.github/workflows/ci.yml` changes; the PR says so (AGENTS.md).

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: the classifier decides whether a required main-protection gate demands evidence; a too-broad rule silently weakens the gate, and both PR and main-push ranges share it)
Blast radius: a too-broad pattern exempts code/image changes from trusted Docker evidence; a too-narrow one keeps the current 1.5 h cost; a crash that reads as "docs-only" would skip the gate
Selected risk packs: Public API / CLI / script entry; Config / project setup; Error handling; Legacy compatibility; Documentation
Evidence floor: pnpm test:guardrails (new accept/reject cases, red against the old .md-only rule); replay of #647 and #644 file lists; pnpm lint:shell, lint:ci, lint:agents, lint:config, fmt:check; actual CI run on this PR showing the job still requires evidence (the diff contains code)
```
