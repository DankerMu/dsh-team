#!/usr/bin/env bash
# scripts/dev-server.sh start|stop|status|logs — background dev-server lifecycle.
# State lives in .run/ (gitignored): pidfile and log.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

port="${PLATFORM_PORT:-8080}"
health_url="http://127.0.0.1:${port}/healthz"
pidfile=".run/dev.pid"
logfile=".run/dev.log"
ready_timeout_seconds=30

running() {
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

healthy() {
  curl -fsS "$health_url" 2>/dev/null | grep -q '"status":"ok"'
}

start() {
  mkdir -p .run
  if running; then
    echo "dev server already running (pid $(cat "$pidfile"))"
    return 0
  fi
  # Job control gives the server its own process group, so stop can signal the group.
  set -m
  node --env-file-if-exists=.env platform/src/main.ts >"$logfile" 2>&1 &
  echo "$!" >"$pidfile"
  set +m
  for _ in $(seq 1 "$ready_timeout_seconds"); do
    if healthy; then
      echo "dev server ready (pid $(cat "$pidfile")) — $health_url"
      return 0
    fi
    running || break
    sleep 1
  done
  echo "dev server not ready after ${ready_timeout_seconds}s — last log lines:" >&2
  tail -n 20 "$logfile" >&2 || true
  stop >/dev/null
  return 1
}

stop() {
  if [ ! -f "$pidfile" ]; then
    echo "no pidfile — dev server not running (or started outside dev:bg)"
    return 0
  fi
  pid="$(cat "$pidfile")"
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  rm -f "$pidfile"
  echo "dev server stopped"
}

status() {
  if running; then
    echo "pid:    $(cat "$pidfile") (running)"
  else
    echo "pid:    not running"
  fi
  if healthy; then
    echo "health: OK ($health_url)"
  else
    echo "health: UNREACHABLE ($health_url)" >&2
    return 1
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n 100 -f "$logfile" ;;
  *)
    echo "usage: dev-server.sh start|stop|status|logs" >&2
    exit 2
    ;;
esac
