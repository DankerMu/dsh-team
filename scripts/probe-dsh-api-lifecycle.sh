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
  if [ "${DSH_TEAM_BROWSER_RUNTIME:-}" != "docker-isolated-network" ] ||
    ! [[ "${DSH_TEAM_BROWSER_IMAGE_ID:-}" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    [ -z "${CHROME_BIN:-}" ] || [ ! -x "${CHROME_BIN}" ]; then
    echo "${probe_name}: use the root package command with pinned CHROME_BIN and isolated browser provisioning" >&2
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

# Artifact acquisition wraps Docker in Node; its deadline must reach both processes.
probe_run_group_bound() {
  local seconds="$1"
  shift
  timeout --kill-after=5 "$seconds" "$@"
}

probe_note_cleanup_failure() {
  echo "${probe_name}: cleanup failed: $1" >&2
  cleanup_failed=1
}

probe_has_cleanup_failure() {
  [ "$cleanup_failed" -ne 0 ]
}

probe_stop_chrome() {
  local receipt_file="$1"
  [ -n "$receipt_file" ] && [ -f "$receipt_file" ] || return 0
  if ! probe_run_bound "$((chrome_wait + docker_seconds * 3 + 45))" \
    node "${repo_root}/scripts/probe-browser-runtime.mjs" rescue "$receipt_file"; then
    export browser_cleanup_failed=1
    probe_note_cleanup_failure "owned browser receipt rescue; retaining private paths"
    return 1
  fi
}

# Read-only absence proof, as strict as isAbsentResource: exit 1, empty stdout, exact daemon text.
probe_absent() {
  local kind="$1" target="$2" noun ref errf out err status
  case "$kind" in
    rm) noun=container ref="$target" ;;
    rmi)
      noun=image ref="$target"
      case "$target" in *:*) ;; *) ref="${target}:latest" ;; esac
      ;;
    network) noun=network ref="$target" ;;
    *) return 1 ;;
  esac
  errf="$(mktemp "${TMPDIR:-/tmp}/${probe_name}-inspect.XXXXXX")" || return 1
  if out="$(probe_run_bound "$docker_seconds" docker "$noun" inspect --format '{{.Id}}' "$target" 2>"$errf")"; then
    status=0
  else
    status=$?
  fi
  # The sentinel keeps every trailing newline so exactly one is stripped, as isAbsentResource does.
  err="$(cat "$errf" && printf x)" || err=""
  rm -f "$errf"
  err="${err%x}"
  err="${err%$'\n'}"
  if [ "$status" -ne 1 ] || { [ -n "$out" ] && ! { [ "$noun" = network ] && [ "$out" = "[]" ]; }; }; then
    return 1
  fi
  [ "$err" = "Error response from daemon: No such ${noun}: ${ref}" ] || [ "$err" = "Error: No such ${noun}: ${ref}" ] ||
    { [ "$noun" = network ] && [ "$err" = "Error response from daemon: network ${ref} not found" ]; }
}

# Runs one canonical orchestrator export from the checkout; probes never reimplement it in bash.
probe_orchestrator() {
  local script="$1"
  shift
  node --input-type=module -e "import { pathToFileURL } from 'node:url';
const orchestrator = await import(pathToFileURL(process.argv[1]).href);
${script}" "${repo_root}/platform/src/orchestrator/index.ts" "$@"
}

# DSH 0.2.1 binds only its overlay's concrete address, so each probe Web container sits at the
# base+2 of an owned /28. The subnet is chosen from a fresh IPAM snapshot of every Docker network
# merged with the host IPv4 kernel routes (a host proxy tun can own part of the test pool), parsed
# by the same hostRouteCidrs as the Docker fixtures. A missing or malformed route table fails.
# Prints "<subnet> <base+2 address>".
probe_allocate_subnet() {
  local ids cidrs
  ids="$(probe_run_bound "$docker_seconds" docker network ls --quiet --no-trunc)" || return 1
  # shellcheck disable=SC2086 # one argument per hexadecimal network ID
  cidrs="$(probe_run_bound "$docker_seconds" docker network inspect --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' $ids)" || return 1
  printf '%s\n' "$cidrs" | probe_orchestrator "import { readFileSync } from 'node:fs';
const { hostRouteCidrs } = await import(pathToFileURL(process.argv[2]).href);
let routes;
try {
  routes = hostRouteCidrs(readFileSync(process.argv[3], 'utf8'));
} catch {
  process.stderr.write(process.argv[4] + ': host route table unreadable or malformed\\n');
  process.exit(1);
}
const occupied = readFileSync(0, 'utf8').split('\\n').map((line) => line.trim()).filter(Boolean);
const subnet = orchestrator.allocateSubnet('198.18.0.0/15', [...occupied, ...routes]);
process.stdout.write(subnet + ' ' + orchestrator.instanceAddressLayout(subnet).container);" \
    "${repo_root}/platform/test/web-startup-fixture.ts" "${PROBE_ROUTE_TABLE:-/proc/net/route}" "$probe_name"
}

# A creation conflict fails the probe; no other subnet is retried.
probe_create_network() {
  local network="$1" subnet="$2"
  probe_run_bound "$docker_seconds" docker network create --driver bridge --subnet "$subnet" \
    --label "dsh-team.test-run=${run_id}" "$network" >/dev/null
}

probe_remove_network() {
  local target="$1" status=0
  set +e
  probe_run_bound "$docker_seconds" docker network rm "$target" >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 0 ] && return 0
  probe_absent network "$target" && return 0
  probe_note_cleanup_failure "docker network rm ${target}"
}

probe_remove_owned() {
  local kind="$1" target="$2" err status=0
  set +e
  err="$(probe_run_bound "$docker_seconds" docker "$kind" -f "$target" 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 0 ] && return 0
  probe_absent "$kind" "$target" && return 0
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
    if [ "$status" -ne 0 ] && ! probe_absent rmi "$image"; then
      probe_note_cleanup_failure "scrub bind dirs"
    fi
  fi
  set +e
  err="$(probe_run_bound "$docker_seconds" docker rm -f "$helper" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ] && ! probe_absent rm "$helper"; then
    probe_note_cleanup_failure "docker rm -f ${helper}"
  fi
}

# The token is read only from the released launch line naming the container's base+2 address.
probe_wait_launch_token() {
  local container="$1" seconds="$2" address="$3" elapsed=0 token=""
  while [ "$elapsed" -lt "$seconds" ]; do
    probe_run_bound "$docker_seconds" docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -q true || {
      echo "${probe_name}: container exited before token line" >&2
      return 1
    }
    token="$(probe_run_bound "$docker_seconds" docker logs "$container" 2>&1 | probe_orchestrator "import { readFileSync } from 'node:fs';
const token = orchestrator.extractLaunchToken(readFileSync(0, 'utf8'), process.argv[2]);
if (token !== undefined) process.stdout.write(token);" "$address")"
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
