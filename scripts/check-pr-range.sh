#!/usr/bin/env bash
# scripts/check-pr-range.sh <base> <head> — `pnpm lint:pr`, the CI layer of the
# commit-message and naming gates (#665). It lints only the range's own commits
# (commitlint over base..head) and the paths it adds or renames
# (check-naming.sh --range: net base...head plus each base..head commit, a
# merge by its dense combined diff), so history before the base is never
# re-checked. An unreadable range, including
# a base equal to the head, fails closed with a fixed reason; it is never
# treated as empty. Must run on bare macOS (bash 3.2).
set -u

unreadable() {
  echo "lint:pr: unreadable range" >&2
  exit 2
}

[ "$#" -eq 2 ] || unreadable
base="$(git rev-parse --verify --quiet "$1^{commit}")" || unreadable
head="$(git rev-parse --verify --quiet "$2^{commit}")" || unreadable
[ "$base" != "$head" ] || unreadable
git merge-base "$base" "$head" >/dev/null || unreadable

# Both gates always run, so one report names every violation in the range.
status=0
pnpm exec commitlint --from "$base" --to "$head" || status=1
bash "$(dirname "${BASH_SOURCE[0]}")/../.git-hooks/check-naming.sh" --range "$base" "$head" || status=1
exit "$status"
