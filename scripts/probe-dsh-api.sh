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
The verification browser is launched with --no-sandbox because Ubuntu AppArmor
can reject Chrome user namespaces ("No usable sandbox"). That flag applies only
to this ephemeral loopback-only Chrome (isolated per-run profile, 127.0.0.1 DSH
origin). It does not change host sysctl/AppArmor policy or the DSH container
seccomp/privilege boundary.
Env: DMXAPI_KEY (required); CHROME_BIN (required executable, no PATH search);
PROBE_PORT (1024-65535); PROBE_STARTUP_SECONDS (1-180, default 60);
PROBE_BROWSER_SECONDS (1-300, default 120); PROBE_TASK_SECONDS (1-300, default 180).
EOF
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { usage; exit 0; }
probe_name="probe-dsh-api"
# shellcheck source=scripts/probe-dsh-api-lifecycle.sh
. "$(cd "$(dirname "$0")" && pwd)/probe-dsh-api-lifecycle.sh"
startup_seconds="${PROBE_STARTUP_SECONDS-60}"
browser_seconds="${PROBE_BROWSER_SECONDS-120}"
task_seconds="${PROBE_TASK_SECONDS-180}"
probe_int_env PROBE_STARTUP_SECONDS "$startup_seconds" 180
probe_int_env PROBE_BROWSER_SECONDS "$browser_seconds" 300
probe_int_env PROBE_TASK_SECONDS "$task_seconds" 300
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
probe_require_bins
[ -n "${DMXAPI_KEY:-}" ] || { echo "probe-dsh-api: DMXAPI_KEY is missing" >&2; exit 2; }
probe_require_gnu_timeout
probe_require_chrome
seccomp="${repo_root}/images/seccomp/dsh-user.json"
overlay_src="${repo_root}/verify/phase0/managed.patch.yml"
driver="${repo_root}/scripts/probe-dsh-api-browser.mjs"
ui="${repo_root}/scripts/probe-dsh-api-ui.mjs"
cdp="${repo_root}/scripts/probe-dsh-api-cdp.mjs"
lifecycle="${repo_root}/scripts/probe-dsh-api-lifecycle.sh"
for f in "$seccomp" "$overlay_src" "$driver" "$ui" "$cdp" "$lifecycle"; do
  [ -f "$f" ] || { echo "probe-dsh-api: missing $f" >&2; exit 2; }
done
port="$(probe_pick_port)"
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
evidence=""
home_dir=""
work_dir=""
build_seconds=180
docker_seconds=30
chrome_wait=12
drive_seconds=$((startup_seconds + browser_seconds * 10 + task_seconds * 9 + 180))
run_bound() { probe_run_bound "$@"; }
stop_chrome() { probe_stop_chrome "${workdir:+${workdir}/chrome.pid}"; }
remove_owned() { probe_remove_owned "$@"; }
scrub_binds() { probe_scrub_binds "$image" "$home_dir" "$work_dir" "${prefix}-scrub"; }
cleanup() {
  [ "$cleaned" -eq 1 ] && return 0
  trap '' INT TERM
  stop_chrome
  [ "$container_owned" -eq 1 ] && remove_owned rm "$container"
  [ "$image_owned" -eq 1 ] && [ -n "$workdir" ] && scrub_binds
  [ "$image_owned" -eq 1 ] && remove_owned rmi "$image"
  [ -n "$workdir" ] && [ -d "$workdir" ] && { rm -rf "$workdir" || probe_note_cleanup_failure "rm -rf workdir"; }
  cleaned=1
  probe_has_cleanup_failure && [ "$probe_status" -eq 0 ] && probe_status=1
  trap - INT TERM
}
# shellcheck disable=SC2317
on_signal() { probe_status="$1"; cleanup; trap - EXIT INT TERM; exit "$probe_status"; }
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
workdir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
evidence="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}-evidence.XXXXXX")"
home_dir="${workdir}/home"
work_dir="${workdir}/work"
overlay="${workdir}/patch.yml"
mkdir -p "$home_dir" "$work_dir" "${workdir}/chrome"
chmod 777 "$home_dir" "$work_dir"
cp "$overlay_src" "$overlay"
echo "probe-dsh-api: run_id=${run_id} image=${image} port=${port} workdir=${workdir} evidence=${evidence}"
run_bound "$build_seconds" docker build -t "$image" -f "${repo_root}/images/dsh-user/Dockerfile" "${repo_root}/images/dsh-user" >/dev/null
image_owned=1
container_owned=1
run_bound "$docker_seconds" docker run -d --name "$container" --user 1001:1001 --hostname "u-probe-${run_id}" \
  -p "127.0.0.1:${port}:3080" --security-opt "seccomp=${seccomp}" -e DMXAPI_KEY \
  -e DSH_TELEMETRY_DISABLED=1 \
  --mount "type=bind,src=${overlay},dst=/managed/patch.yml,ro" \
  --mount "type=bind,src=${home_dir},dst=/data/home" \
  --mount "type=bind,src=${work_dir},dst=/data/work" \
  "$image" dsh --profile web --patch /managed/patch.yml --no-open --trusted-host "127.0.0.1:${port}" >/dev/null
token=""
set +e
token="$(probe_wait_launch_token "$container" "$startup_seconds")"
probe_status=$?
set -e
if [ "$probe_status" -ne 0 ] || [ -z "$token" ]; then
  probe_status=1
  cleanup
  trap - EXIT INT TERM
  exit "$probe_status"
fi
printf '%s' "$token" >"${workdir}/launch.token"
chmod 600 "${workdir}/launch.token"
set +e
run_bound 20 env PROBE_HOST=127.0.0.1 PROBE_PORT="$port" PROBE_TOKEN_FILE="${workdir}/launch.token" node "$driver" exchange >"${workdir}/cookie.hdr"
probe_status=$?
set -e
if [ "$probe_status" -ne 0 ]; then
  echo "probe-dsh-api: token exchange failed" >&2
  cleanup
  trap - EXIT INT TERM
  exit "$probe_status"
fi
chmod 600 "${workdir}/cookie.hdr"
set +e
run_bound "$drive_seconds" env PROBE_ORIGIN="http://127.0.0.1:${port}" PROBE_COOKIE_FILE="${workdir}/cookie.hdr" \
  PROBE_HOME="$home_dir" PROBE_WORK="$work_dir" PROBE_SCREENSHOT="${evidence}/homepage.png" \
  PROBE_PROFILE="${workdir}/chrome" PROBE_PID_FILE="${workdir}/chrome.pid" \
  PROBE_BROWSER_SECONDS="$browser_seconds" PROBE_TASK_SECONDS="$task_seconds" \
  CHROME_BIN="$CHROME_BIN" node "$driver" drive
probe_status=$?
set -e
cleanup
trap - EXIT INT TERM
exit "$probe_status"
