#!/usr/bin/env bash
# scripts/probe-sandbox.sh — task 1.2 sandbox probe. Invoke: pnpm probe:sandbox
#
# Builds images/dsh-user, then tries Docker default, custom seccomp
# (moby/profiles seccomp/v0.2.3 + clone/unshare/mount/umount2/pivot_root),
# then that policy plus systempaths=unconfined. Each level runs the pinned
# DSH bash tool in Workspace Write. Usable = workspace marker written exactly
# and DSH_HOME marker absent. No --privileged / seccomp=unconfined.
# Cleanup on EXIT/INT/TERM removes only this run's dsh-team-probe-sandbox-* resources.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm probe:sandbox

Probes DSH bash under Workspace Write through three Docker security levels.
Prints each level's options, failure reason, and the first usable combination.

Env: PROBE_TIMEOUT_SECONDS (default 90)
EOF
}

[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { usage; exit 0; }

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
for bin in docker curl node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "probe-sandbox: $bin is not on PATH" >&2; exit 2; }
done

run_id="$(date +%s)-$$"
prefix="dsh-team-probe-sandbox-${run_id}"
image="${prefix}-image"
workdir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
seccomp_file="${workdir}/dsh-user-seccomp.json"
driver="${repo_root}/scripts/probe-sandbox-bash-tool.mjs"
timeout_seconds="${PROBE_TIMEOUT_SECONDS:-90}"
seccomp_url="https://raw.githubusercontent.com/moby/profiles/seccomp/v0.2.3/seccomp/default.json"
seccomp_sha256="536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74"
level_names=(docker-default custom-seccomp custom-seccomp-systempaths)
probe_status=0
cleanup_failed=0
cleaned=0

note_cleanup_failure() { echo "probe-sandbox: cleanup failed: $1" >&2; cleanup_failed=1; }

cleanup() {
  [ "$cleaned" -eq 1 ] && return 0
  cleaned=1
  local name
  for name in "${level_names[@]}"; do
    docker inspect "${prefix}-${name}" >/dev/null 2>&1 || continue
    docker rm -f "${prefix}-${name}" >/dev/null 2>&1 || note_cleanup_failure "docker rm -f ${prefix}-${name}"
  done
  if docker image inspect "$image" >/dev/null 2>&1; then
    docker rmi -f "$image" >/dev/null 2>&1 || note_cleanup_failure "docker rmi -f $image"
  fi
  [ -d "$workdir" ] && { rm -rf "$workdir" || note_cleanup_failure "rm -rf $workdir"; }
  [ "$cleanup_failed" -ne 0 ] && [ "$probe_status" -eq 0 ] && probe_status=1
  return 0
}

# shellcheck disable=SC2317
on_signal() { probe_status="$1"; cleanup; trap - EXIT; exit "$probe_status"; }

trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

write_custom_seccomp() {
  local raw="${workdir}/moby-default.json" actual
  curl -fsSL "$seccomp_url" -o "$raw"
  actual="$(node -e 'const fs=require("node:fs"); const c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$raw")"
  [ "$actual" = "$seccomp_sha256" ] || {
    echo "probe-sandbox: seccomp digest mismatch: expected ${seccomp_sha256} got ${actual}" >&2
    return 1
  }
  node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); p.syscalls=[...p.syscalls,{names:["clone","unshare","mount","umount2","pivot_root"],action:"SCMP_ACT_ALLOW"}]; fs.writeFileSync(process.argv[2], JSON.stringify(p));' "$raw" "$seccomp_file"
  echo "seccomp source=${seccomp_url} sha256=${actual} extra=clone,unshare,mount,umount2,pivot_root"
}

wait_for_container() {
  local container="$1" waiter waited=0
  docker wait "$container" >/dev/null 2>&1 &
  waiter=$!
  while kill -0 "$waiter" 2>/dev/null; do
    if [ "$waited" -ge "$timeout_seconds" ]; then
      echo "level timeout after ${timeout_seconds}s" >&2
      docker kill "$container" >/dev/null 2>&1 || true
      wait "$waiter" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$waiter" || true
}

collect_result() {
  local name="$1" log="$2" docker_status="$3" result=""
  [ -s "$log" ] && { cat "$log"; result="$(grep '^PROBE_RESULT ' "$log" | tail -n 1 || true)"; }
  if [ -z "$result" ]; then
    echo "level ${name}: unusable (no PROBE_RESULT; docker_status=${docker_status})"
    return 1
  fi
  echo "$result"
  if grep -q '"usable":true' <<<"$result"; then
    echo "level ${name}: usable"
    echo "workspace write succeeded; state directory write rejected"
    return 0
  fi
  echo "level ${name}: unusable (${result#PROBE_RESULT })"
  return 1
}

run_level() {
  local name="$1" container log docker_status=0 start_status
  shift
  container="${prefix}-${name}"
  log="${workdir}/${name}.log"
  echo
  echo "=== level ${name} ==="
  if [ "$#" -eq 0 ]; then echo "security-opt: Docker default (engine embedded profile)"; else echo "security-opt: $*"; fi
  set +e
  docker run -d --name "$container" --user 1001:1001 \
    --mount "type=bind,src=${driver},dst=/probe/probe-sandbox-bash-tool.mjs,ro" \
    "$@" "$image" node /probe/probe-sandbox-bash-tool.mjs >/dev/null
  start_status=$?
  if [ "$start_status" -eq 0 ]; then wait_for_container "$container"; docker_status=$?; else docker_status=$start_status; fi
  docker logs "$container" >"$log" 2>&1
  set -e
  collect_result "$name" "$log" "$docker_status"
}

echo "probe-sandbox: run_id=${run_id} image=${image} workdir=${workdir}"
docker build -t "$image" -f "${repo_root}/images/dsh-user/Dockerfile" "${repo_root}/images/dsh-user"
write_custom_seccomp

first_usable=""
failures=()
if run_level docker-default; then first_usable="docker-default"; else failures+=(docker-default); fi
if [ -z "$first_usable" ]; then
  if run_level custom-seccomp --security-opt "seccomp=${seccomp_file}"; then first_usable="custom-seccomp"; else failures+=(custom-seccomp); fi
fi
if [ -z "$first_usable" ]; then
  if run_level custom-seccomp-systempaths --security-opt "seccomp=${seccomp_file}" --security-opt systempaths=unconfined; then
    first_usable="custom-seccomp-systempaths"
  else
    failures+=(custom-seccomp-systempaths)
  fi
fi

echo
if [ -n "$first_usable" ]; then
  echo "first usable level: ${first_usable}"
  probe_status=0
else
  echo "no usable level" >&2
  echo "failed levels: ${failures[*]}" >&2
  probe_status=1
fi
cleanup
trap - EXIT INT TERM
exit "$probe_status"
