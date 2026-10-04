#!/usr/bin/env bash
# Shared Docker/browser lifecycle for DSH probes. Sourced by probe-dsh-api.sh
# and probe-first-run.sh. Callers set probe_name, probe_status, cleanup_failed,
# docker_seconds, and chrome_wait before invoking these functions.
# shellcheck disable=SC2154

probe_int_env() {
  local name="$1" value="$2" max="$3" min="${4:-1}"
  if ! [[ "$value" =~ ^[1-9][0-9]{0,5}$ ]] || [ "$value" -gt "$max" ] || [ "$value" -lt "$min" ]; then
    echo "${probe_name}: ${name} must be an integer ${min}-${max}, got ${value:-<empty>}" >&2
    exit 2
  fi
}

probe_require_bins() {
  local bin
  for bin in docker node timeout; do
    command -v "$bin" >/dev/null 2>&1 || {
      echo "${probe_name}: $bin is not on PATH" >&2
      exit 2
    }
  done
}

probe_require_gnu_timeout() {
  case "$(timeout --version 2>/dev/null || true)" in
    *'GNU coreutils'*) ;;
    *)
      echo "${probe_name}: GNU timeout is required" >&2
      exit 2
      ;;
  esac
}

probe_require_chrome() {
  if [ -z "${CHROME_BIN:-}" ] || [ ! -x "${CHROME_BIN}" ]; then
    echo "${probe_name}: CHROME_BIN must be an executable browser path" >&2
    exit 2
  fi
}

probe_pick_port() {
  local chosen
  if [ -n "${PROBE_PORT:-}" ]; then
    probe_int_env PROBE_PORT "$PROBE_PORT" 65535 1024
    printf '%s' "$PROBE_PORT"
    return 0
  fi
  chosen="$(node -e 'import("node:net").then(({createServer})=>{const s=createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});})')"
  probe_int_env PROBE_PORT "$chosen" 65535 1024
  printf '%s' "$chosen"
}

probe_run_bound() {
  local seconds="$1"
  shift
  timeout --foreground --kill-after=5 "$seconds" "$@"
}

probe_note_cleanup_failure() {
  echo "${probe_name}: cleanup failed: $1" >&2
  cleanup_failed=1
}

probe_has_cleanup_failure() {
  [ "$cleanup_failed" -ne 0 ]
}

probe_stop_chrome() {
  local pid_file="$1" pid="" waited=0
  [ -n "$pid_file" ] && [ -f "$pid_file" ] || return 0
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "${pid:-}" =~ ^[1-9][0-9]{0,9}$ ]] || return 0
  kill "$pid" >/dev/null 2>&1 || true
  while [ "$waited" -lt "$chrome_wait" ]; do
    kill -0 "$pid" >/dev/null 2>&1 || return 0
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
  waited=0
  while [ "$waited" -lt 3 ]; do
    kill -0 "$pid" >/dev/null 2>&1 || return 0
    sleep 1
    waited=$((waited + 1))
  done
}

probe_remove_owned() {
  local kind="$1" target="$2" err status=0
  set +e
  err="$(probe_run_bound "$docker_seconds" docker "$kind" -f "$target" 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 0 ] && return 0
  case "$err" in *"No such container"* | *"No such image"*) return 0 ;; esac
  probe_note_cleanup_failure "docker ${kind} -f ${target}"
}

probe_scrub_binds() {
  local image="$1" home_dir="$2" work_dir="$3" helper="$4" err status=0
  if [ -n "$image" ] && [ -n "$home_dir" ] && [ -n "$work_dir" ]; then
    set +e
    err="$(probe_run_bound "$docker_seconds" docker run --rm --pull=never --name "$helper" --user 0:0 \
      --mount "type=bind,src=${home_dir},dst=/s/home" \
      --mount "type=bind,src=${work_dir},dst=/s/work" \
      "$image" sh -c 'find /s/home /s/work -mindepth 1 -delete' 2>&1)"
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      case "$err" in *"No such image"* | *"Unable to find image"*) ;; *) probe_note_cleanup_failure "scrub bind dirs" ;; esac
    fi
  fi
  set +e
  err="$(probe_run_bound "$docker_seconds" docker rm -f "$helper" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    case "$err" in *"No such container"*) ;; *) probe_note_cleanup_failure "docker rm -f ${helper}" ;; esac
  fi
}

probe_wait_launch_token() {
  local container="$1" seconds="$2" elapsed=0 token=""
  while [ "$elapsed" -lt "$seconds" ]; do
    probe_run_bound "$docker_seconds" docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true || {
      echo "${probe_name}: container exited before token line" >&2
      return 1
    }
    token="$(probe_run_bound "$docker_seconds" docker logs "$container" 2>&1 | node -e 'const t=require("node:fs").readFileSync(0,"utf8");const m=t.match(/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/);if(m)process.stdout.write(m[1]);')"
    if [ -n "$token" ]; then
      printf '%s' "$token"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "${probe_name}: no launch-token line within ${seconds}s" >&2
  return 1
}

probe_register_helper() {
  local helper="$1"
  owned_containers+=("$helper")
}

probe_run_helper() {
  local helper="$1"
  shift
  probe_register_helper "$helper"
  probe_run_bound "$docker_seconds" docker run --rm --pull=never --name "$helper" "$@"
}

probe_chown_tree() {
  local image="$1" target="$2" helper="$3" status=0
  probe_register_helper "$helper"
  set +e
  probe_run_bound "$docker_seconds" docker run --rm --pull=never --name "$helper" --user 0:0 \
    --mount "type=bind,src=${target},dst=/s/tree" \
    "$image" sh -c 'chmod -R a+rwX /s/tree && chown -R 1001:1001 /s/tree' >/dev/null 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "${probe_name}: chown failed" >&2
    return 1
  fi
}

probe_copy_permitted_home() {
  local image="$1" src="$2" dest="$3" helper="$4" status=0
  mkdir -p "$dest"
  probe_register_helper "$helper"
  set +e
  probe_run_bound "$docker_seconds" docker run --rm --pull=never --name "$helper" --user 0:0 \
    -e PROBE_HOME=/s/src -e PROBE_SNAPSHOT=/s/dest \
    --mount "type=bind,src=${src},dst=/s/src,ro" \
    --mount "type=bind,src=${dest},dst=/s/dest" \
    --mount "type=bind,src=${repo_root}/scripts,dst=/probe,ro" \
    "$image" sh -c 'node /probe/probe-first-run.mjs snapshot-home && chmod -R a+rwX /s/dest' >/dev/null 2>&1
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "${probe_name}: snapshot copy failed" >&2
    return 1
  fi
}

probe_sanitize_text() {
  node -e 'const fs=require("node:fs"); const raw=fs.readFileSync(process.argv[1],"utf8"); const out=raw.replace(/https?:\/\/[^\s]+/gi,"[url]").replace(/[A-Za-z0-9+/=_-]{24,}/g,"[id]").replace(/(token|cookie|authorization)=\S+/gi,(_,key)=>key+"=[redacted]"); fs.writeFileSync(process.argv[1], out);' "$1"
}
