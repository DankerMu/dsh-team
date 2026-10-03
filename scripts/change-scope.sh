#!/usr/bin/env bash
# scripts/change-scope.sh <base-ref> — deterministic change inventory.
# Explicit base required: guessing origin/<branch> fails on unpushed worktrees
# and misreports stacked branches. Rename detection is off so both sides of a
# rename stay visible to check selection.
set -euo pipefail
BASE="${1:?usage: change-scope.sh <base-ref> (explicit; this script never guesses a base)}"
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || {
  echo "error: base '$BASE' does not resolve locally; fetch it yourself first" >&2; exit 2; }
MERGE_BASE=$(git merge-base "$BASE" HEAD)
echo "# base=$BASE merge_base=$MERGE_BASE head=$(git rev-parse HEAD)"
echo "## committed"; git -c diff.renames=false diff --name-status "$MERGE_BASE"..HEAD
echo "## staged";    git -c diff.renames=false diff --name-status --cached
echo "## unstaged";  git -c diff.renames=false diff --name-status
echo "## untracked"; git ls-files --others --exclude-standard
