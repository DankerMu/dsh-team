#!/usr/bin/env bash
# scripts/check-test-pairing.sh — every production source file has a sibling test.
# TDD is required in this repo (constraints.yaml testing.tdd_mode): a source file
# without a test next to it was written implementation-first.
# Scans platform/src and plugin host sources in the working tree. Exempt by design:
#   *.test.ts(x)            the tests themselves
#   *.d.ts, types.ts, *.types.ts   type-only files with no runtime behaviour
#   index.ts                module entry files that only re-export
#   platform/src/main.ts    process entry point (constraints.yaml exemptions)
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

roots=()
[ -d platform/src ] && roots+=("platform/src")
for dir in plugins/*; do
  [ -d "$dir" ] && roots+=("$dir")
done
if [ "${#roots[@]}" -eq 0 ]; then
  echo "check-test-pairing: no source roots (platform/src, plugins/*) found — extend this gate" >&2
  exit 1
fi

checked=0
missing=()
while IFS= read -r file; do
  case "$file" in
    *.test.ts | *.test.tsx | *.test.js | *.d.ts | */types.ts | *.types.ts | */index.ts | platform/src/main.ts) continue ;;
  esac
  checked=$((checked + 1))
  stem="${file%.*}"
  ext="${file##*.}"
  if [ ! -f "$stem.test.$ext" ] && [ ! -f "$stem.test.ts" ]; then
    missing+=("  $file  expected \"$stem.test.$ext\", found none")
  fi
done < <(find "${roots[@]}" -type f \( -name '*.ts' -o -name '*.tsx' -o -path '*/permission-tiers/*.js' \) | sort)

if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "check-test-pairing: source files without a sibling test file:"
    printf '%s\n' "${missing[@]}"
    echo "  fix: write the failing test first, next to the source file (see platform/AGENTS.md § Test-Driven Development)"
  } >&2
  exit 1
fi

echo "check-test-pairing: $checked source files checked, all have a sibling test."
