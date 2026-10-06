#!/usr/bin/env bash
# scripts/check-agents-commands.sh — AGENTS.md may only document commands that exist.
# Agents execute documented commands verbatim, so a stale command is worse than none.
# Checks every command written as code (`pnpm [--silent] <script>` in backticks,
# or a quoted "pnpm [--silent] <script>" in constraints.yaml) in AGENTS.md, platform/AGENTS.md and
# constraints.yaml against the root package.json scripts. Prose mentions of pnpm
# are not commands and are ignored.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# pnpm built-ins that are not package scripts.
builtins=" install exec add remove update dlx run "

scripts="$(node -e 'process.stdout.write(Object.keys(require("./package.json").scripts).join("\n"))')"

checked=0
missing=()
for doc in AGENTS.md platform/AGENTS.md constraints.yaml; do
  if [ ! -f "$doc" ]; then
    echo "check-agents-commands: $doc is missing — it is part of the documented command surface" >&2
    exit 1
  fi
  while IFS=: read -r line name; do
    [ -z "$name" ] && continue
    case "$builtins" in *" $name "*) continue ;; esac
    checked=$((checked + 1))
    if ! printf '%s\n' "$scripts" | grep -qx -- "$name"; then
      missing+=("  $doc:$line  \"pnpm $name\" is not a script in package.json")
    fi
  done < <(grep -n -o -E '[`"]pnpm (--silent )?[a-z][a-z0-9:-]*' "$doc" | sed -E 's/^([0-9]+):.pnpm (--silent )?/\1:/')
done

if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "check-agents-commands: documented commands that do not exist:"
    printf '%s\n' "${missing[@]}"
    echo "  fix: add the script to package.json or correct the document in the same change"
  } >&2
  exit 1
fi

echo "check-agents-commands: $checked documented commands checked, all exist in package.json."
