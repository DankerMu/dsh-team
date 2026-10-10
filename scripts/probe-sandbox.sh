#!/usr/bin/env bash
# scripts/probe-sandbox.sh — task 1.2. pnpm probe:sandbox
# Docker default → custom seccomp → +systempaths. Owned-object cleanup.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pnpm probe:sandbox
Probes DSH bash under Workspace Write through three Docker security levels.
Prints each level's options, failure reason, and the first usable combination.
Env: PROBE_TIMEOUT_SECONDS (positive integer 1-600, default 90)
EOF
}

[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { usage; exit 0; }

timeout_seconds="${PROBE_TIMEOUT_SECONDS-90}"
if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$timeout_seconds" -gt 600 ]; then
  echo "probe-sandbox: PROBE_TIMEOUT_SECONDS must be a positive integer 1-600, got ${timeout_seconds:-<empty>}" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
for bin in docker curl node timeout; do
  command -v "$bin" >/dev/null 2>&1 || { echo "probe-sandbox: $bin is not on PATH" >&2; exit 2; }
done

run_id="$(date +%s)-$$"
prefix="dsh-team-probe-sandbox-${run_id}"
image="${prefix}-image"
seccomp_url="https://raw.githubusercontent.com/moby/profiles/seccomp/v0.2.3/seccomp/default.json"
seccomp_sha256="536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74"
driver="${repo_root}/scripts/probe-sandbox-bash-tool.mjs"
owned_containers=()
image_owned=0
probe_status=0
cleanup_failed=0
cleaned=0
workdir=""

note_cleanup_failure() { echo "probe-sandbox: cleanup failed: $1" >&2; cleanup_failed=1; }
remove_owned() {
  local kind="$1" target="$2" err
  err="$(docker "$kind" -f "$target" 2>&1)" && return 0
  case "$err" in *"No such container"* | *"No such image"*) return 0 ;; esac
  note_cleanup_failure "docker ${kind} -f ${target}: ${err}"
}

cleanup() {
  [ "$cleaned" -eq 1 ] && return 0
  trap '' INT TERM
  local target
  for target in "${owned_containers[@]}"; do remove_owned rm "$target"; done
  [ "$image_owned" -eq 1 ] && remove_owned rmi "$image"
  [ -n "$workdir" ] && [ -d "$workdir" ] && { rm -rf "$workdir" || note_cleanup_failure "rm -rf $workdir"; }
  cleaned=1
  [ "$cleanup_failed" -ne 0 ] && [ "$probe_status" -eq 0 ] && probe_status=1
  trap - INT TERM
  return 0
}

# shellcheck disable=SC2317
on_signal() { probe_status="$1"; cleanup; trap - EXIT INT TERM; exit "$probe_status"; }
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

workdir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
seccomp_file="${workdir}/dsh-user-seccomp.json"

write_custom_seccomp() {
  local raw="${workdir}/moby-default.json" actual
  curl -fsSL "$seccomp_url" -o "$raw"
  actual="$(node -e 'const fs=require("node:fs"); const c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$raw")"
  [ "$actual" = "$seccomp_sha256" ] || { echo "probe-sandbox: seccomp digest mismatch: expected ${seccomp_sha256} got ${actual}" >&2; return 1; }
  node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); p.syscalls=[...p.syscalls,{names:["clone","unshare","mount","umount2","pivot_root"],action:"SCMP_ACT_ALLOW"}]; fs.writeFileSync(process.argv[2], JSON.stringify(p));' "$raw" "$seccomp_file"
  echo "seccomp source=${seccomp_url} sha256=${actual} extra=clone,unshare,mount,umount2,pivot_root"
}

wait_for_container() {
  local container="$1" wait_out wait_status
  if wait_out="$(timeout --foreground "$timeout_seconds" docker wait "$container")"; then
    wait_out="${wait_out%%$'\n'*}"
    case "$wait_out" in '' | *[!0-9]*) echo "docker wait returned non-integer: ${wait_out}" >&2; return 2 ;; esac
    return "$wait_out"
  else
    wait_status=$?
    docker kill "$container" >/dev/null 2>&1 || true
    if [ "$wait_status" -eq 124 ]; then echo "level timeout after ${timeout_seconds}s" >&2; return 124; fi
    echo "docker wait failed: status=${wait_status}" >&2
    return "$wait_status"
  fi
}

collect_result() {
  local name="$1" log="$2" docker_status="$3" parse_out parse_status
  [ -s "$log" ] && cat "$log"
  set +e
  parse_out="$(node -e '
const fs=require("node:fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).filter(l=>l.startsWith("PROBE_RESULT "));
if(lines.length!==1){process.stdout.write("malformed or duplicate PROBE_RESULT");process.exit(2);}
let rec;try{rec=JSON.parse(lines[0].slice(13));}catch{rec=null;}
if(!rec||typeof rec!=="object"){process.stdout.write("malformed PROBE_RESULT");process.exit(2);}
if(rec.usable===true&&rec.wsOk===true&&rec.stateDenied===true&&rec.statePresent===false) process.exit(0);
process.stdout.write(typeof rec.reason==="string"&&rec.reason?rec.reason:"PROBE_RESULT not usable");
process.exit(1);
' "$log")"
  parse_status=$?
  set -e
  if [ "$docker_status" -ne 0 ]; then echo "level ${name}: unusable (container exit=${docker_status}${parse_out:+; ${parse_out}})"; return 1; fi
  if [ "$parse_status" -eq 0 ]; then
    echo "level ${name}: usable"
    echo "workspace write succeeded; state directory write rejected"
    return 0
  fi
  if [ "$parse_status" -eq 1 ]; then echo "level ${name}: unusable (${parse_out})"; else echo "level ${name}: unusable (${parse_out:-malformed or duplicate PROBE_RESULT}; docker_status=${docker_status})"; fi
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
  owned_containers+=("$container")
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
image_owned=1
docker build -t "$image" -f "${repo_root}/images/dsh-user/Dockerfile" \
  --build-context "zh-locale=${repo_root}/plugins/zh-locale" \
  --build-context "permission-tiers=${repo_root}/plugins/permission-tiers" "${repo_root}/images/dsh-user"
write_custom_seccomp

first_usable=""
failures=()
if run_level docker-default; then first_usable="docker-default"; else failures+=(docker-default); fi
if [ -z "$first_usable" ]; then
  if run_level custom-seccomp --security-opt "seccomp=${seccomp_file}"; then first_usable="custom-seccomp"; else failures+=(custom-seccomp); fi
fi
if [ -z "$first_usable" ]; then
  if run_level custom-seccomp-systempaths --security-opt "seccomp=${seccomp_file}" --security-opt systempaths=unconfined; then first_usable="custom-seccomp-systempaths"; else failures+=(custom-seccomp-systempaths); fi
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
