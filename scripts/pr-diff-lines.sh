#!/usr/bin/env bash
# scripts/pr-diff-lines.sh <from> <to> — prints the PR diff-size count (#715):
# added plus removed lines of <from>...<to>, whitespace ignored, deleted files,
# binary files, pnpm-lock.yaml and schemas/openapi.json excluded. CI passes the
# merge ref's parents (HEAD^1 HEAD^2), so commits the base gained after the PR
# branched are never counted. Counts --numstat fields, so lines whose content
# starts with + or -, and blank lines, are counted like any other line; type
# changes (T, e.g. a symlink replaced by a file) count like modifications.
# Attributes come from <from> (--attr-source), never from a .gitattributes the PR
# adds to the merge-ref work tree (#734). --attr-source needs git >= 2.40; an older
# git rejects it, which fails closed like any failing git diff.
# Fails closed: a wrong argument count, an unresolvable ref or a failing git diff
# exits 2 with a fixed reason and prints no count. git's own exit status is
# checked; the default CI shell has no pipefail. Must run on bare macOS (bash 3.2).
set -u

uncountable() {
  echo "pr-diff-lines.sh: cannot count the PR diff" >&2
  exit 2
}

[ "$#" -eq 2 ] || uncountable
from="$(git rev-parse --verify --quiet "$1^{commit}")" || uncountable
to="$(git rev-parse --verify --quiet "$2^{commit}")" || uncountable
numstat="$(git --attr-source="$from" diff --numstat --diff-filter=ACMRT --ignore-all-space \
  --end-of-options "$from...$to" -- . \
  ':(exclude)pnpm-lock.yaml' ':(exclude)schemas/openapi.json')" || uncountable
# Binary rows are "-<TAB>-<TAB>path": only all-digit fields are summed.
printf '%s\n' "$numstat" | awk -F '\t' '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { n += $1 + $2 } END { print n + 0 }'
