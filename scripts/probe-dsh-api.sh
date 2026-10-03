#!/usr/bin/env bash
# scripts/probe-dsh-api.sh — tasks 2.1/2.2. pnpm probe:dsh-api
# Disposable web instance, Host token exchange, real UI inventory, idle samples.
set -euo pipefail
usage() {
  cat <<'EOF'
Usage: pnpm probe:dsh-api
Starts one dsh-team-prefixed Web instance from images/dsh-user, exchanges the
launch token with node:http Host, drives the real UI, prints HTTP/WS paths for
homepage / new Session / message / running / complete, and samples HTTP, WS,
and state-file channels across three real task cycles.
Env: DMXAPI_KEY (required); CHROME_BIN (required executable, no PATH search);
PROBE_PORT (1024-65535); PROBE_STARTUP_SECONDS (1-180, default 60);
PROBE_BROWSER_SECONDS (1-300, default 120); PROBE_TASK_SECONDS (1-300, default 180).
EOF
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { usage; exit 0; }
int_env() {
  local name="$1" value="$2" max="$3" min="${4:-1}"
  if ! [[ "$value" =~ ^[1-9][0-9]{0,5}$ ]] || [ "$value" -gt "$max" ] || [ "$value" -lt "$min" ]; then
    echo "probe-dsh-api: ${name} must be an integer ${min}-${max}, got ${value:-<empty>}" >&2
    exit 2
  fi
}
startup_seconds="${PROBE_STARTUP_SECONDS-60}"
browser_seconds="${PROBE_BROWSER_SECONDS-120}"
task_seconds="${PROBE_TASK_SECONDS-180}"
int_env PROBE_STARTUP_SECONDS "$startup_seconds" 180
int_env PROBE_BROWSER_SECONDS "$browser_seconds" 300
int_env PROBE_TASK_SECONDS "$task_seconds" 300
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
for bin in docker node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "probe-dsh-api: $bin is not on PATH" >&2; exit 2; }
done
[ -n "${DMXAPI_KEY:-}" ] || { echo "probe-dsh-api: DMXAPI_KEY is missing" >&2; exit 2; }
if [ -z "${CHROME_BIN:-}" ] || [ ! -x "${CHROME_BIN}" ]; then
  echo "probe-dsh-api: CHROME_BIN must be an executable browser path" >&2
  exit 2
fi
seccomp="${repo_root}/images/seccomp/dsh-user.json"
overlay_src="${repo_root}/verify/phase0/managed.patch.yml"
driver="${repo_root}/scripts/probe-dsh-api-browser.mjs"
for f in "$seccomp" "$overlay_src" "$driver"; do
  [ -f "$f" ] || { echo "probe-dsh-api: missing $f" >&2; exit 2; }
done
if [ -n "${PROBE_PORT:-}" ]; then
  int_env PROBE_PORT "$PROBE_PORT" 65535 1024
  port="$PROBE_PORT"
else
  port="$(node -e 'import("node:net").then(({createServer})=>{const s=createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});})')"
  int_env PROBE_PORT "$port" 65535 1024
fi
run_id="$(date +%s)-$$"
prefix="dsh-team-probe-api-${run_id}"
image="${prefix}-image"
container="${prefix}-container"
image_owned=0
container_owned=0
probe_status=0
cleanup_failed=0
cleaned=0
workdir=""
note_cleanup_failure() { echo "probe-dsh-api: cleanup failed: $1" >&2; cleanup_failed=1; }
remove_owned() {
  local kind="$1" target="$2" err
  err="$(docker "$kind" -f "$target" 2>&1)" && return 0
  case "$err" in *"No such container"* | *"No such image"*) return 0 ;; esac
  note_cleanup_failure "docker ${kind} -f ${target}: ${err}"
}
cleanup() {
  [ "$cleaned" -eq 1 ] && return 0
  trap '' INT TERM
  local pid
  if [ -n "$workdir" ] && [ -f "${workdir}/chrome.pid" ]; then
    pid="$(cat "${workdir}/chrome.pid" 2>/dev/null || true)"
    if [[ "${pid:-}" =~ ^[1-9][0-9]{0,9}$ ]]; then kill "$pid" >/dev/null 2>&1 || true; fi
  fi
  [ "$container_owned" -eq 1 ] && remove_owned rm "$container"
  [ "$image_owned" -eq 1 ] && remove_owned rmi "$image"
  [ -n "$workdir" ] && [ -d "$workdir" ] && { rm -rf "$workdir" || note_cleanup_failure "rm -rf $workdir"; }
  cleaned=1
  [ "$cleanup_failed" -ne 0 ] && [ "$probe_status" -eq 0 ] && probe_status=1
  trap - INT TERM
}
# shellcheck disable=SC2317
on_signal() { probe_status="$1"; cleanup; trap - EXIT INT TERM; exit "$probe_status"; }
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
workdir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
home_dir="${workdir}/home"
work_dir="${workdir}/work"
overlay="${workdir}/patch.yml"
mkdir -p "$home_dir" "$work_dir" "${workdir}/chrome"
chmod 777 "$home_dir" "$work_dir"
cp "$overlay_src" "$overlay"
echo "probe-dsh-api: run_id=${run_id} image=${image} port=${port} workdir=${workdir}"
image_owned=1
docker build -t "$image" -f "${repo_root}/images/dsh-user/Dockerfile" "${repo_root}/images/dsh-user" >/dev/null
container_owned=1
docker run -d --name "$container" --user 1001:1001 --hostname "u-probe-${run_id}" \
  -p "127.0.0.1:${port}:3080" --security-opt "seccomp=${seccomp}" -e DMXAPI_KEY \
  -e DSH_TELEMETRY_DISABLED=1 \
  --mount "type=bind,src=${overlay},dst=/managed/patch.yml,ro" \
  --mount "type=bind,src=${home_dir},dst=/data/home" \
  --mount "type=bind,src=${work_dir},dst=/data/work" \
  "$image" dsh --profile web --patch /managed/patch.yml --no-open --trusted-host "127.0.0.1:${port}" >/dev/null
token=""
elapsed=0
while [ "$elapsed" -lt "$startup_seconds" ]; do
  docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true || {
    echo "probe-dsh-api: container exited before token line" >&2
    probe_status=1
    cleanup; trap - EXIT INT TERM; exit "$probe_status"
  }
  token="$(docker logs "$container" 2>&1 | node -e 'const t=require("node:fs").readFileSync(0,"utf8");const m=t.match(/dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/);if(m)process.stdout.write(m[1]);')"
  [ -n "$token" ] && break
  sleep 1
  elapsed=$((elapsed + 1))
done
[ -n "$token" ] || { echo "probe-dsh-api: no launch-token line within ${startup_seconds}s" >&2; probe_status=1; cleanup; trap - EXIT INT TERM; exit "$probe_status"; }
printf '%s' "$token" >"${workdir}/launch.token"
chmod 600 "${workdir}/launch.token"
PROBE_HOST=127.0.0.1 PROBE_PORT="$port" PROBE_TOKEN_FILE="${workdir}/launch.token" node "$driver" exchange >"${workdir}/cookie.hdr" || {
  echo "probe-dsh-api: token exchange failed" >&2
  probe_status=1; cleanup; trap - EXIT INT TERM; exit "$probe_status"
}
chmod 600 "${workdir}/cookie.hdr"
set +e
PROBE_ORIGIN="http://127.0.0.1:${port}" PROBE_COOKIE_FILE="${workdir}/cookie.hdr" PROBE_HOME="$home_dir" \
  PROBE_SCREENSHOT="${workdir}/homepage.png" PROBE_PROFILE="${workdir}/chrome" \
  PROBE_PID_FILE="${workdir}/chrome.pid" PROBE_BROWSER_SECONDS="$browser_seconds" \
  PROBE_TASK_SECONDS="$task_seconds" CHROME_BIN="$CHROME_BIN" node "$driver" drive
probe_status=$?
set -e
cleanup
trap - EXIT INT TERM
exit "$probe_status"
