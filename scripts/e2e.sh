#!/usr/bin/env bash
# Own a private real Engine before the built-artifact scenario can start main.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$repo_root/scripts/e2e-engine.mjs"
