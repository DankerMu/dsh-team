#!/usr/bin/env bash
set -euo pipefail

args=(--watch)
# Node24's Linux watcher registers even absent --env-file-if-exists paths.
if [[ -e .env || -L .env ]]; then
  args+=(--env-file=.env)
fi
exec node "${args[@]}" platform/src/main.ts
