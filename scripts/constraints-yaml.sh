# shellcheck shell=bash
# scripts/constraints-yaml.sh — sourced helper: yaml_get reads one known key of
# constraints.yaml. Sourced by .git-hooks/check-naming.sh and scripts/docs-only-diff.sh.
# Must run on bare macOS (bash 3.2) with sed/grep only; do not add deps (e.g., yq).
# A missing file or unknown key returns 1; a missing known key prints nothing.

yaml_get() {
  local path="${1:?yaml path required}"
  local file="${2:?yaml file required}"

  [ -f "$file" ] || return 1

  case "$path" in
    code_canonicality.forbidden_suffixes.patterns)
      sed -n '/^code_canonicality:/,/^size_limits:/p' "$file" \
        | sed -n '/^  forbidden_suffixes:/,/^  scratchpad_directories:/p' \
        | grep -E '^[[:space:]]*-[[:space:]]*' \
        | sed -E "s/^[[:space:]]*-[[:space:]]*//; s/[[:space:]]*$//; s/^[\\\"']//; s/[\\\"']$//"
      ;;
    code_canonicality.scratchpad_directories.paths)
      sed -n '/^code_canonicality:/,/^size_limits:/p' "$file" \
        | sed -n '/^  scratchpad_directories:/,/^size_limits:/p' \
        | grep -m 1 -E '^[[:space:]]*paths:' \
        | sed -E 's/^[[:space:]]*paths:[[:space:]]*//; s/[[:space:]]*$//'
      ;;
    code_canonicality.scratchpad_directories.managed_archive_pattern)
      sed -n '/^code_canonicality:/,/^size_limits:/p' "$file" \
        | sed -n '/^  scratchpad_directories:/,/^size_limits:/p' \
        | grep -m 1 -E '^[[:space:]]*managed_archive_pattern:' \
        | sed -E "s/^[[:space:]]*managed_archive_pattern:[[:space:]]*//; s/[[:space:]]*$//; s/^[\\\"']//; s/[\\\"']$//"
      ;;
    *)
      return 1
      ;;
  esac
}
