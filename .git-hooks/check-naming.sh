#!/usr/bin/env bash
# .git-hooks/check-naming.sh
# Rejects commits that add files whose names violate code-canonicality rules.
# Entrypoints, one classifier (path_violations):
#   <path>                 one path (agent write-time check), exit 2 on violation;
#   (no arguments)         the staged index, from .husky/pre-commit, exit 1;
#   --range <base> <head>  paths base...head adds or renames, plus every path any
#                          base..head commit adds or renames (a later deletion
#                          does not hide it), from CI through
#                          scripts/check-pr-range.sh (`pnpm lint:pr`), exit 1.
# .git-hooks/ is not a hooks directory: core.hooksPath stays husky's .husky/_.
#
# See AGENTS.md § Code Canonicality.

set -euo pipefail

# Regex source: repo-root `constraints.yaml` (preferred) or fallback defaults (legacy repos).
# - Forbidden suffix patterns: `code_canonicality.forbidden_suffixes.patterns`
# - Scratchpad directories: `code_canonicality.scratchpad_directories.paths`
#
# This hook must run on bare macOS (bash 3.2). Do not add non-default deps (e.g., yq).
DEFAULT_FORBIDDEN_SUFFIX_RE='(_v[0-9]+|_new|_old|_backup|_temp|_copy|_final|_real|_improved|_refactored|_fixed|_legacy|_deprecated|_archive|_save|V[0-9]+|New|Old|Legacy|Deprecated|Backup)(\.|/|$)'
DEFAULT_SCRATCH_DIR_RE='(^|/)(tmp|scratch|backup|_old|deprecated|archive|wip)(/|$)'

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
constraints_file="$repo_root/constraints.yaml"

# shellcheck source=scripts/constraints-yaml.sh
. "$(dirname "${BASH_SOURCE[0]}")/../scripts/constraints-yaml.sh"

FORBIDDEN_SUFFIX_RE="$DEFAULT_FORBIDDEN_SUFFIX_RE"
SCRATCH_DIR_RE="$DEFAULT_SCRATCH_DIR_RE"
MANAGED_ARCHIVE_RE=""
forbidden_source="fallback"
scratch_source="fallback"

if [ -f "$constraints_file" ]; then
  forbidden_joined=""
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    pat="${pat%\$}"
    if [ -z "$forbidden_joined" ]; then
      forbidden_joined="$pat"
    else
      forbidden_joined="$forbidden_joined|$pat"
    fi
  done <<EOF
$(yaml_get 'code_canonicality.forbidden_suffixes.patterns' "$constraints_file" 2>/dev/null || true)
EOF

  if [ -n "$forbidden_joined" ]; then
    # Convert identifier-style patterns (often `$`-anchored) into a path-component check.
    FORBIDDEN_SUFFIX_RE="(${forbidden_joined})(\\.|/|$)"
    forbidden_source="constraints.yaml"
  fi

  scratch_paths_line="$(yaml_get 'code_canonicality.scratchpad_directories.paths' "$constraints_file" 2>/dev/null || true)"
  if [ -n "$scratch_paths_line" ]; then
    scratch_cleaned="$(printf '%s' "$scratch_paths_line" | sed -E "s/^[[:space:]]*\\[//; s/\\][[:space:]]*$//; s/[\\\"']//g; s/,/ /g")"
    scratch_joined=""
    for term in $scratch_cleaned; do
      term="${term#/}"
      term="${term%/}"
      [ -z "$term" ] && continue
      if [ -z "$scratch_joined" ]; then
        scratch_joined="$term"
      else
        scratch_joined="$scratch_joined|$term"
      fi
    done
    if [ -n "$scratch_joined" ]; then
      SCRATCH_DIR_RE="(^|/)(${scratch_joined})(/|$)"
      scratch_source="constraints.yaml"
    fi
  fi
  MANAGED_ARCHIVE_RE="$(yaml_get 'code_canonicality.scratchpad_directories.managed_archive_pattern' "$constraints_file" 2>/dev/null || true)"
fi

echo "check-naming.sh: FORBIDDEN_SUFFIX_RE source: $forbidden_source" >&2
echo "check-naming.sh: SCRATCH_DIR_RE source:    $scratch_source" >&2

path_violations() {
  local original="$1"
  local scratch_path="$1"
  if [[ "$original" =~ $FORBIDDEN_SUFFIX_RE ]]; then
    printf '  forbidden naming suffix: %s\n' "$original"
  fi
  case "/$original/" in
    */./*|*/../*) ;;
    *)
      if [ -n "$MANAGED_ARCHIVE_RE" ] && [[ "$original" =~ $MANAGED_ARCHIVE_RE ]]; then
        # Exempt one managed component, never the remaining path or suffix rules.
        scratch_path="${original/\/archive\//\/}"
      fi
      ;;
  esac
  if [[ "$scratch_path" =~ $SCRATCH_DIR_RE ]]; then
    printf '  scratchpad directory:    %s\n' "$original"
  fi
}

# Range mode (CI): parsed before the path argument so `--range` is never a path.
# An unreadable or empty range fails; it is never read as an empty list.
if [ "${1:-}" = "--range" ]; then
  if [ "$#" -ne 3 ]; then
    echo "check-naming.sh: usage: --range <base> <head>" >&2
    exit 2
  fi
  range="$2...$3"
  if [ -z "$2" ] || [ -z "$3" ]; then
    echo "check-naming.sh: unreadable range $range" >&2
    exit 2
  fi
# Path-argument mode (agent write-time check): validate one path directly
# instead of reading the staged index.
elif [ "$#" -gt 0 ]; then
  f="$1"
  if [ -n "$(path_violations "$f")" ]; then
    echo "naming violation (write-time): $f — see AGENTS.md § Code Canonicality" >&2
    exit 2
  fi
  exit 0
fi

# Names are read NUL-delimited (-z): otherwise core.quotePath C-quotes non-ASCII,
# quote and newline names, and no rule matches them. Command substitution drops
# NULs, so the list goes through a file.
changed="$(mktemp)" || exit 2
trap 'rm -f "$changed"' EXIT
if [ "${1:-}" = "--range" ]; then
  # The union (#715): `git log` lists each commit's own paths, so a path added and
  # later deleted inside the range is still seen, but it lists none for a merge
  # commit; the net diff still names paths only a merge adds.
  if ! git diff -z --name-only --diff-filter=AR --end-of-options "$range" -- >"$changed" ||
    ! git log -z --format= --name-only --diff-filter=AR --end-of-options "$2..$3" -- >>"$changed"; then
    echo "check-naming.sh: unreadable range $range" >&2
    exit 2
  fi
else
  # Read added or renamed files (cached).
  git diff --cached -z --name-only --diff-filter=AR >"$changed" 2>/dev/null || true
fi

# Avoid `mapfile` so the script works on macOS default bash 3.2 as well as bash 4+.
violations=()
while IFS= read -r -d '' f; do
  [[ -z "$f" ]] && continue
  found="$(path_violations "$f")"
  [ -n "$found" ] || continue
  # A path in both range sets is reported once (bash 3.2: no associative arrays).
  for seen in "${violations[@]+"${violations[@]}"}"; do
    [ "$seen" != "$found" ] || continue 2
  done
  violations+=("$found")
done <"$changed"

if [ "${#violations[@]}" -gt 0 ]; then
  cat <<EOF
Code canonicality violation — these path(s) cannot be committed:

$(printf '%s\n' "${violations[@]}")

Why: parallel versions (_v1, _v2, _new), placeholder names (_temp, _copy), and
scratchpad directories cause the codebase to bloat with duplicate logic.

What to do:
  - If you are refactoring: rename the new file over the old one and let git track the change in history.
  - If this is genuinely a separate concept: rename to something descriptive (no suffix).
  - If this is throwaway exploration: keep it outside the repo (e.g., /tmp).

See AGENTS.md § Code Canonicality for the full rule.
EOF
  exit 1
fi

exit 0
