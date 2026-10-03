#!/usr/bin/env bash
# scripts/e2e.sh — end-to-end check of the built artifact: build, start
# platform/dist on a free port, run the hurl suite over real HTTP, stop.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

command -v hurl >/dev/null 2>&1 || {
  echo "e2e: hurl is not installed — install it (https://hurl.dev) and re-run" >&2
  exit 2
}

pnpm build

port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
log="$(mktemp "${TMPDIR:-/tmp}/dsh-team-e2e.XXXXXX")"
PLATFORM_HOST=127.0.0.1 PLATFORM_PORT="$port" PLATFORM_LOG_LEVEL=info node platform/dist/main.js >"$log" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -f "$log"
}
trap cleanup EXIT

base_url="http://127.0.0.1:${port}"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "e2e: built server did not become healthy at $base_url — log:" >&2
  cat "$log" >&2
  exit 1
fi

hurl --test --variable base_url="$base_url" smoke/*.hurl
echo "e2e: built artifact served smoke/*.hurl at $base_url."
