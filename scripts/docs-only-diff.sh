#!/usr/bin/env bash
# scripts/docs-only-diff.sh — decides whether a diff needs no trusted Docker evidence.
# Stdin: `git diff -z --no-renames --name-only` output: NUL-delimited, byte-exact
# paths (#715; without -z git C-quotes non-ASCII names). Empty entries are ignored.
# Exit 0, `docs-only` plus the paths: non-empty and every path is documentation.
# Exit 1, `evidence required: <first offending path>` or `evidence required: empty diff`.
# Exit 2: classifier configuration unreadable; callers must fail, never exempt.
# Documentation: Markdown outside plugins/ and images/ (their Markdown ships in
# images), or OpenSpec change metadata at exactly openspec/changes/<change>/.openspec.yaml
# or openspec/changes/archive/YYYY-MM-DD-<change>/.openspec.yaml. The date and name
# grammar is constraints.yaml managed_archive_pattern (#199), not restated here.
# Runs before Node is set up in CI and on macOS bash 3.2: bash, sed and grep only.
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 2
constraints_file="$script_dir/../constraints.yaml"
# shellcheck source=scripts/constraints-yaml.sh
. "$script_dir/constraints-yaml.sh" || exit 2

archive_key="code_canonicality.scratchpad_directories.managed_archive_pattern"
archive_re="$(yaml_get "$archive_key" "$constraints_file" 2>/dev/null)" || archive_re=""
if [ -z "$archive_re" ]; then
  echo "docs-only-diff.sh: cannot read $archive_key from constraints.yaml" >&2
  exit 2
fi
[[ "" =~ $archive_re ]]
if [ "$?" -eq 2 ]; then
  echo "docs-only-diff.sh: $archive_key in constraints.yaml is not a valid regex" >&2
  exit 2
fi

# Exactly one change directory below openspec/changes/ or openspec/changes/archive/.
is_change_metadata() {
  local path="$1" name
  case "$path" in
    openspec/changes/*/.openspec.yaml) ;;
    *) return 1 ;;
  esac
  name="${path#openspec/changes/}"
  name="${name%/.openspec.yaml}"
  case "$name" in
    archive/*/*) return 1 ;;
    archive/*) [[ "$path" =~ $archive_re ]] ;;
    */* | archive) return 1 ;;
    *) [[ "openspec/changes/archive/0000-00-00-$name/.openspec.yaml" =~ $archive_re ]] ;;
  esac
}

is_documentation() {
  case "$1" in
    plugins/* | images/*) return 1 ;;
    *.md) return 0 ;;
  esac
  is_change_metadata "$1"
}

# Indexed append keeps 20k-path diffs linear; string concatenation was quadratic.
paths=()
while IFS= read -r -d '' path || [ -n "$path" ]; do
  [ -n "$path" ] || continue
  if ! is_documentation "$path"; then
    echo "evidence required: $path"
    exit 1
  fi
  paths[${#paths[@]}]="$path"
done

# bash 3.2 with set -u treats "${paths[@]}" of an empty array as unbound.
if [ "${#paths[@]}" -eq 0 ]; then
  echo "evidence required: empty diff"
  exit 1
fi
echo "docs-only"
printf '%s\n' "${paths[@]}"
