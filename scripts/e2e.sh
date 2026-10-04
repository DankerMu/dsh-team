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
log=""
data_dir=""
server_pid=""

cleanup() {
  if [ -n "${server_pid}" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "${log}" ]; then
    rm -f "$log"
  fi
  if [ -n "${data_dir}" ]; then
    rm -rf "$data_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log="$(mktemp "${TMPDIR:-/tmp}/dsh-team-e2e.XXXXXX")"
data_dir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-team-e2e-data.XXXXXX")"

base_url="http://127.0.0.1:${port}"
export PLATFORM_HOST=127.0.0.1
export PLATFORM_PORT="$port"
export PLATFORM_LOG_LEVEL=info
export PLATFORM_DATA_DIR="$data_dir"
export PLATFORM_PUBLIC_URL="$base_url"
export PLATFORM_COOKIE_SECURE=false
export PLATFORM_TRUSTED_PROXIES=
node platform/dist/main.js >"$log" 2>&1 &
server_pid=$!

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

if [ ! -f "$data_dir/platform.db" ]; then
  echo "e2e: healthy server did not create $data_dir/platform.db — log:" >&2
  cat "$log" >&2
  exit 1
fi

node --input-type=module <<'EOF'
import { join } from 'node:path';
import { openDatabase } from './platform/dist/db/index.js';

const dir = process.env.PLATFORM_DATA_DIR;
if (dir === undefined || dir === '') {
  throw new Error('e2e: PLATFORM_DATA_DIR is missing');
}
const db = openDatabase(join(dir, 'platform.db'));
try {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  if (
    JSON.stringify(names) !==
    JSON.stringify([
      'audit_events',
      'instances',
      'platform_sessions',
      'schema_migrations',
      'settings',
      'users',
    ])
  ) {
    throw new Error(`e2e: unexpected schema tables ${JSON.stringify(names)}`);
  }
  if (JSON.stringify(versions) !== JSON.stringify([{ version: 1 }])) {
    throw new Error(`e2e: unexpected migration ledger ${JSON.stringify(versions)}`);
  }
} finally {
  db.close();
}
EOF

echo "e2e: database schema/migration OK"
hurl --test --variable base_url="$base_url" smoke/*.hurl
echo "e2e: built artifact served smoke/*.hurl at $base_url."
