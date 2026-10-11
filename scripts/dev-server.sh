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
lockdir=".run/dev.lock"
stoppingfile=".run/dev.stopping"
ready_timeout_seconds=30
stop_timeout_seconds=30

# Serialize complete ownership transitions. A competing command fails rather than
# observing a predecessor's health or replacing its PID while graceful stop drains.
lock() {
  mkdir -p .run
  if ! mkdir "$lockdir" 2>/dev/null; then
    echo "dev lifecycle operation already in progress ($lockdir)" >&2
    return 1
  fi
  trap 'rmdir "$lockdir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

running() {
  [ -f "$pidfile" ] && process_running "$(cat "$pidfile")"
}

process_running() {
  kill -0 "$1" 2>/dev/null || return 1
  # Exited, unreaped children no longer own a listener or database.
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  [[ -n "$state" && "$state" != *Z* ]]
}

healthy() {
  curl --connect-timeout 1 --max-time 2 -fsS "$health_url" 2>/dev/null | grep -q '"status":"ok"'
}

start() {
  mkdir -p .run
  lock
  if running; then
    if [ -f "$stoppingfile" ] || ! healthy || ! running; then
      echo "dev server still starting or stopping; ownership retained" >&2
      return 1
    fi
    echo "dev server already running (pid $(cat "$pidfile"))"
    return 0
  fi
  rm -f "$stoppingfile"
  if healthy; then
    echo "dev port already serves another listener — refusing unrelated readiness" >&2
    return 1
  fi
  # Build only after this invocation owns startup; an idempotent/concurrent start
  # must not clear the live server's generated browser assets.
  pnpm build:web
  # Production main always reconciles real Docker before listening; fail before recording a PID.
  node --env-file-if-exists=.env --input-type=module -e \
    'import {loadConfig} from "./platform/src/config.ts"; import {createDockerClient} from "./platform/src/orchestrator/index.ts"; const c=loadConfig(process.env); await createDockerClient(c.dockerSocketPath).json("GET","/version",undefined,AbortSignal.timeout(10000));'
  # Job control gives the server its own process group, so stop can signal the group.
  set -m
  node --env-file-if-exists=.env platform/src/main.ts >"$logfile" 2>&1 &
  echo "$!" >"$pidfile"
  set +m
  # Cancellation preserves ownership until this captured child actually exits.
  trap 'stop_owned; exit 130' INT
  trap 'stop_owned; exit 143' TERM
  for _ in $(seq 1 "$ready_timeout_seconds"); do
    running || break
    if healthy && running; then
      echo "dev server ready (pid $(cat "$pidfile")) — $health_url"
      return 0
    fi
    sleep 1
  done
  echo "dev server not ready after ${ready_timeout_seconds}s — inspect $logfile privately" >&2
  stop_owned
  return 1
}

stop_owned() {
  if [ ! -f "$pidfile" ]; then
    echo "no pidfile — dev server not running (or started outside dev:bg)"
    return 0
  fi
  local pid
  pid="$(cat "$pidfile")"
  if process_running "$pid"; then
    echo "$pid" >"$stoppingfile"
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 "$stop_timeout_seconds"); do
      process_running "$pid" || break
      sleep 1
    done
    if process_running "$pid"; then
      echo "dev server still stopping (pid $pid); ownership retained" >&2
      return 1
    fi
  fi
  # Lock ownership prevents a concurrent start from replacing the captured PID.
  rm -f "$pidfile" "$stoppingfile"
  echo "dev server stopped"
}

stop() {
  lock
  stop_owned
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
