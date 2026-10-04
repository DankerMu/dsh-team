#!/usr/bin/env bash
# scripts/probe-first-run.sh — tasks 3.1–3.3. pnpm probe:first-run
# Fresh mapped-host matrix: baseline, overlay, preseed, CLI, combined, composition.
set -euo pipefail
usage() {
  cat <<'EOF'
Usage: pnpm probe:first-run
Starts uniquely named dsh-team Web instances with empty state/work volumes and
a fresh Chrome profile per trial. Observes workspace readiness, Chinese UI, and
Preview Notice independently on a non-loopback hostname mapped only inside
Chrome. Tries managed overlay, preseeded files, launch arguments, then the
repo-owned locale/roster composition (first entry and refresh). Prints the
measured recipe or 无法做到. No model key is required.
Env: CHROME_BIN (required executable, no PATH search);
PROBE_PORT (1024-65535); PROBE_STARTUP_SECONDS (1-180, default 60);
PROBE_BROWSER_SECONDS (1-300, default 120).
PROBE_COMPOSITION_FAULT (negative controls only): missing-plugin, wrong-plugin,
reenabled-notice. The acceptance roster stays unchanged; each must fail.
PROBE_COMPOSITION_EXTRA_PATCH (optional readable YAML, composition only):
e.g. a non-secret two-model fixture for subsequent real-UI preservation checks.
PROBE_COMPOSITION_PRESERVE_MODELS (optional): two comma-separated fixture display
names. Exercises General settings and both model selections after refresh, before cleanup.
EOF
}
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { usage; exit 0; }
probe_name="probe-first-run"
# shellcheck source=scripts/probe-dsh-api-lifecycle.sh
. "$(cd "$(dirname "$0")" && pwd)/probe-dsh-api-lifecycle.sh"
startup_seconds="${PROBE_STARTUP_SECONDS-60}"
browser_seconds="${PROBE_BROWSER_SECONDS-120}"
probe_int_env PROBE_STARTUP_SECONDS "$startup_seconds" 180
probe_int_env PROBE_BROWSER_SECONDS "$browser_seconds" 300
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
probe_require_bins
probe_require_gnu_timeout
probe_require_chrome
for bin in python3 tar; do
  command -v "$bin" >/dev/null 2>&1 || { echo "probe-first-run: prerequisite missing" >&2; exit 2; }
done
node -e 'if(Number(process.versions.node.split(".")[0])<24) process.exit(2)' || exit 2
probe_run_bound 15 docker info >/dev/null 2>&1 || { echo "probe-first-run: Docker unavailable" >&2; exit 2; }
if [ -n "${PROBE_PORT:-}" ]; then probe_int_env PROBE_PORT "$PROBE_PORT" 65535 1024; fi
seccomp="${repo_root}/images/seccomp/dsh-user.json"
driver="${repo_root}/scripts/probe-first-run.mjs"
ui="${repo_root}/scripts/probe-dsh-api-ui.mjs"
cdp="${repo_root}/scripts/probe-dsh-api-cdp.mjs"
lifecycle="${repo_root}/scripts/probe-dsh-api-lifecycle.sh"
api_driver="${repo_root}/scripts/probe-dsh-api-browser.mjs"
composition_shell="${repo_root}/scripts/probe-first-run-composition.sh"
composition_driver="${repo_root}/scripts/probe-first-run-composition.mjs"
preservation_driver="${repo_root}/scripts/probe-first-run-preservation.mjs"
for f in "$seccomp" "$driver" "$ui" "$cdp" "$lifecycle" "$api_driver" "$composition_shell" "$composition_driver" "$preservation_driver"; do
  [ -f "$f" ] || { echo "probe-first-run: missing $f" >&2; exit 2; }
done
# shellcheck source=scripts/probe-first-run-composition.sh
. "$composition_shell"
run_id="$(date +%s)-$$"
prefix="dsh-team-probe-first-run-${run_id}"
image="${prefix}-image"
image_owned=0
probe_status=0
cleanup_failed=0
cleaned=0
workdir=""
evidence=""
build_seconds=180
docker_seconds=30
chrome_wait=12
authority_host="dsh-team-probe.invalid"
owned_containers=()
declare -A trial_homes=()
declare -A trial_works=()
declare -A trial_containers=()
declare -A trial_ports=()
note_cleanup_failure() { probe_note_cleanup_failure "$1"; }
stop_all_chrome() {
  local pid_file
  [ -n "$workdir" ] || return 0
  for pid_file in "$workdir"/*/chrome.pid; do
    [ -f "$pid_file" ] || continue
    probe_stop_chrome "$pid_file"
  done
}
remove_owned() { probe_remove_owned "$@"; }
stop_owned_containers() {
  local name
  for name in "${owned_containers[@]}"; do
    remove_owned rm "$name"
  done
  owned_containers=()
}
scrub_all_binds() {
  local name home_dir work_dir
  [ "$image_owned" -eq 1 ] || return 0
  for name in "${!trial_homes[@]}"; do
    home_dir="${trial_homes[$name]}"
    work_dir="${trial_works[$name]}"
    if [ -z "$home_dir" ] || [ -z "$work_dir" ]; then continue; fi
    probe_scrub_binds "$image" "$home_dir" "$work_dir" "${prefix}-${name}-scrub"
  done
}
cleanup() {
  [ "$cleaned" -eq 1 ] && return 0
  trap '' INT TERM
  stop_all_chrome
  stop_owned_containers
  scrub_all_binds
  [ "$image_owned" -eq 1 ] && remove_owned rmi "$image"
  [ -n "$workdir" ] && [ -d "$workdir" ] && { rm -rf "$workdir" || note_cleanup_failure "rm -rf workdir"; }
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
echo "probe-first-run: run_id=${run_id} image=${image} workdir=${workdir} evidence=${evidence} hostname=${authority_host}"
probe_run_bound "$build_seconds" docker build -t "$image" -f "${repo_root}/images/dsh-user/Dockerfile" "${repo_root}/images/dsh-user" >/dev/null
image_owned=1
write_overlay() {
  local dest="$1" kind="$2"
  if [ "$kind" = "first-run" ]; then
    cat >"$dest" <<'EOF'
- id: webserver
  config:
    host: 0.0.0.0
    port: 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
- id: locale
  config:
    preference: zh
- id: ui-settings-general
  config:
    welcomeNoticeVersion: "2026-09-28.1"
- id: ui-settings-models
  config:
    credentialOnboarding: false
- id: workspace-controller
  config:
    documentsDirectory: /data
EOF
  else
    cat >"$dest" <<'EOF'
- id: webserver
  config:
    host: 0.0.0.0
    port: 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF
  fi
}
prepare_trial_dirs() {
  local name="$1"
  local root="${workdir}/${name}"
  rm -rf "$root"
  mkdir -p "${root}/home" "${root}/work" "${root}/chrome"
  chmod 777 "${root}/home" "${root}/work"
  trial_homes["$name"]="${root}/home"
  trial_works["$name"]="${root}/work"
}
start_instance() {
  local name="$1" overlay="$2" extra_args="${3:-}"
  local port container home_dir work_dir token
  port="$(probe_pick_port)"
  container="${prefix}-${name}"
  home_dir="${trial_homes[$name]}"
  work_dir="${trial_works[$name]}"
  owned_containers+=("$container")
  trial_containers["$name"]="$container"
  trial_ports["$name"]="$port"
  # shellcheck disable=SC2086
  probe_run_bound "$docker_seconds" docker run -d --name "$container" --user 1001:1001 --hostname "u-probe-${name}-${run_id}" \
    -p "127.0.0.1:${port}:3080" --security-opt "seccomp=${seccomp}" \
    -e DSH_TELEMETRY_DISABLED=1 \
    --mount "type=bind,src=${overlay},dst=/managed/patch.yml,ro" \
    --mount "type=bind,src=${home_dir},dst=/data/home" \
    --mount "type=bind,src=${work_dir},dst=/data/work" \
    "$image" dsh --profile web --patch /managed/patch.yml --no-open --trusted-host "${authority_host}:${port}" ${extra_args} >/dev/null
  token="$(probe_wait_launch_token "$container" "$startup_seconds")" || return 1
  printf '%s' "$token" >"${workdir}/${name}/launch.token"
  chmod 600 "${workdir}/${name}/launch.token"
  probe_run_bound 20 env PROBE_HOST=127.0.0.1 PROBE_PORT="$port" PROBE_COOKIE_HOST="$authority_host" \
    PROBE_TOKEN_FILE="${workdir}/${name}/launch.token" node "$driver" exchange >"${workdir}/${name}/cookie.hdr" || return 1
  chmod 600 "${workdir}/${name}/cookie.hdr"
}
stop_instance() {
  local name="$1"
  local container="${trial_containers[$name]:-}"
  [ -n "$container" ] || return 0
  probe_stop_chrome "${workdir}/${name}/chrome.pid"
  remove_owned rm "$container"
  trial_containers["$name"]=""
}
drive_cmd() {
  local name="$1"
  local cmd="$2"
  local shot="$3"
  local port="${trial_ports[$name]}"
  local status=0
  local snap_status=0
  local reason="ok"
  local drive_seconds=$((startup_seconds + browser_seconds + 30))
  # Composition observes two independently bounded entries (initial + refresh).
  if [ "$cmd" = "accept-composition" ]; then drive_seconds=$((drive_seconds + browser_seconds)); fi
  if [ "$cmd" = "accept-composition" ] && [ -n "${PROBE_COMPOSITION_PRESERVE_MODELS:-}" ]; then
    drive_seconds=$((drive_seconds + browser_seconds))
  fi
  if [ "$cmd" != "discover" ]; then
    if ! snapshot_home "$name" "${workdir}/${name}/workspace-snapshot"; then
      printf '%s\n' "2" >"${workdir}/${name}/drive.status"
      printf '%s\n' "pre-snapshot" >"${workdir}/${name}/drive.reason"
      return 2
    fi
  fi
  if probe_run_bound "$drive_seconds" env \
    PROBE_PORT="$port" PROBE_COOKIE_FILE="${workdir}/${name}/cookie.hdr" \
    PROBE_HOME="${trial_homes[$name]}" PROBE_WORK="${trial_works[$name]}" \
    PROBE_WORKSPACE_EVIDENCE="${workdir}/${name}/workspace-snapshot/workspace-evidence.json" \
    PROBE_SCREENSHOT="${evidence}/${shot}" PROBE_PROFILE="${workdir}/${name}/chrome" \
    PROBE_PID_FILE="${workdir}/${name}/chrome.pid" PROBE_BROWSER_SECONDS="$browser_seconds" \
    PROBE_DISCOVER_BEFORE="${workdir}/${name}/before" PROBE_DISCOVER_AFTER="${workdir}/${name}/after" \
    PROBE_DISCOVER_OUT="${workdir}/preseed-files" \
    PROBE_BASELINE_OBSERVATION="${workdir}/baseline/observe.json" \
    CHROME_BIN="$CHROME_BIN" node "$driver" "$cmd"; then
    status=0
  else
    status=$?
    reason="driver"
  fi
  if snapshot_home "$name" "${evidence}/${name}-home-after"; then
    snap_status=0
  else
    snap_status=$?
  fi
  if [ "$snap_status" -ne 0 ]; then
    echo "probe-first-run: ${name} ${cmd} snapshot failed" >&2
    reason="snapshot"
    if [ "$status" -eq 0 ]; then
      status=2
    fi
  fi
  mkdir -p "${workdir}/${name}" "${evidence}/${name}"
  printf '%s\n' "$status" >"${workdir}/${name}/drive.status"
  printf '%s\n' "$reason" >"${workdir}/${name}/drive.reason"
  cp "${workdir}/${name}/drive.status" "${evidence}/${name}/drive.status"
  cp "${workdir}/${name}/drive.reason" "${evidence}/${name}/drive.reason"
  return "$status"
}
snapshot_home() {
  local name="$1"
  local dest="$2"
  rm -rf "$dest" || return 1
  mkdir -p "$dest" || return 1
  probe_copy_permitted_home "$image" "${trial_homes[$name]}" "$dest" "${prefix}-${name}-snap-${dest##*/}" || return 1
}
seed_home() {
  local dest="$1"
  local src="$2"
  local trial="${dest%/home}"
  mkdir -p "$dest" || return 1
  tar -C "$src" -cf - . | tar -C "$dest" -xf - || return 1
  probe_chown_tree "$image" "$dest" "${prefix}-seed-chown-${trial##*/}" || return 1
}
print_json_file() {
  local label="$1"
  local file="$2"
  echo "${label} $(tr '\n' ' ' <"$file")"
}
record_drive() {
  local name="$1"
  local file="$2"
  local status="$3"
  local label="$4"
  local reason="missing-status"
  mkdir -p "${workdir}/${name}" "${evidence}/${name}"
  if [ -f "${workdir}/${name}/drive.reason" ]; then
    reason="$(tr -d '\n' <"${workdir}/${name}/drive.reason")"
  fi
  printf '%s\n' "$status" >"${workdir}/${name}/drive.status"
  printf '%s\n' "$reason" >"${workdir}/${name}/drive.reason"
  cp "${workdir}/${name}/drive.status" "${evidence}/${name}/drive.status"
  cp "${workdir}/${name}/drive.reason" "${evidence}/${name}/drive.reason"
  if [ "$status" -eq 0 ]; then
    print_json_file "$label" "$file"
    return 0
  fi
  probe_status=2
  if [ -s "$file" ]; then
    echo "${label} partial reason=${reason} drive-status-${status} $(tr '\n' ' ' <"$file")"
  else
    echo "${label} error=harness reason=${reason} drive-status-${status}"
  fi
}
run_trial_accept() {
  local name="$1"
  local shot="$2"
  local label="$3"
  local status=0
  if drive_cmd "$name" accept "$shot" >"${workdir}/${name}/accept.json"; then
    status=0
  else
    status=$?
  fi
  record_drive "$name" "${workdir}/${name}/accept.json" "$status" "$label"
}
run_help_container() {
  local helper="$1"
  local out="$2"
  shift 2
  local status=0
  set +e
  probe_run_helper "$helper" --user 1001:1001 "$image" "$@" >"$out" 2>&1
  status=$?
  set -e
  probe_sanitize_text "$out"
  return "$status"
}
capture_cli_help() {
  local help_dir="${evidence}/cli-help"
  local launcher_status web_status status flag
  mkdir -p "$help_dir"
  if run_help_container "${prefix}-help-launcher" "${help_dir}/launcher.help" dsh --help; then
    launcher_status=0
  else
    launcher_status=$?
  fi
  if run_help_container "${prefix}-help-web" "${help_dir}/web.help" dsh --profile web --help; then
    web_status=0
  else
    web_status=$?
  fi
  if [ "$launcher_status" -ne 0 ] || [ "$web_status" -ne 0 ]; then
    echo "cli help error=harness evidence=${help_dir}"
    return 1
  fi
  for flag in workspace locale notice-version; do
    if run_help_container "${prefix}-help-${flag}" "${help_dir}/${flag}.out" dsh --profile web "--${flag}"; then
      status=0
    else
      status=$?
    fi
    if [ "$status" -ne 1 ] || ! grep -Fq "unknown option '--${flag}'" "${help_dir}/${flag}.out"; then
      echo "cli parser unknown flag=${flag} status=${status} evidence=${help_dir}"
      return 1
    fi
    echo "cli parser unsupported flag=--${flag} status=${status} evidence=${help_dir}/${flag}.out"
  done
  printf '%s\n' unsupported >"${help_dir}/status"
  echo "cli help evidence=${help_dir}; --patch delivered configuration is the overlay method"
}

prepare_trial_dirs baseline
write_overlay "${workdir}/baseline/patch.yml" webserver
if ! start_instance baseline "${workdir}/baseline/patch.yml"; then
  echo "probe-first-run: baseline start failed" >&2
  probe_status=2
  cleanup
  trap - EXIT INT TERM
  exit "$probe_status"
fi
if drive_cmd baseline observe "baseline-homepage.png" >"${workdir}/baseline/observe.json"; then
  print_json_file "baseline" "${workdir}/baseline/observe.json"
else
  echo "probe-first-run: baseline observe failed" >&2
  probe_status=2
  if [ -s "${workdir}/baseline/observe.json" ]; then
    echo "baseline partial reason=drive-status-nonzero $(tr '\n' ' ' <"${workdir}/baseline/observe.json")"
  fi
  cleanup
  trap - EXIT INT TERM
  exit "$probe_status"
fi
stop_instance baseline

prepare_trial_dirs overlay
write_overlay "${workdir}/overlay/patch.yml" first-run
if start_instance overlay "${workdir}/overlay/patch.yml"; then
  run_trial_accept overlay "overlay-homepage.png" "method overlay"
else
  echo "method overlay error=harness"
  probe_status=2
  mkdir -p "${workdir}/overlay" "${evidence}/overlay"
  printf '%s\n' "2" >"${workdir}/overlay/drive.status"
  printf '%s\n' "start" >"${workdir}/overlay/drive.reason"
  cp "${workdir}/overlay/drive.status" "${evidence}/overlay/drive.status"
  cp "${workdir}/overlay/drive.reason" "${evidence}/overlay/drive.reason"
fi
stop_instance overlay

prepare_trial_dirs discovery
write_overlay "${workdir}/discovery/patch.yml" webserver
seeded=0
if start_instance discovery "${workdir}/discovery/patch.yml"; then
  if snapshot_home discovery "${workdir}/discovery/before" &&
    drive_cmd discovery discover "discovery-homepage.png" >"${workdir}/discovery/discover.json" &&
    snapshot_home discovery "${workdir}/discovery/after" &&
    PROBE_DISCOVER_BEFORE="${workdir}/discovery/before" PROBE_DISCOVER_AFTER="${workdir}/discovery/after" \
      PROBE_DISCOVER_OUT="${workdir}/preseed-files" node "$driver" diff-home >"${workdir}/discovery/diff.json"; then
    print_json_file "discovery" "${workdir}/discovery/diff.json"
    cat >"${workdir}/preseed-files/cordis.patch.yml" <<'EOF'
- id: locale
  config:
    preference: zh
- id: ui-settings-general
  config:
    welcomeNoticeVersion: "2026-09-28.1"
- id: ui-settings-models
  config:
    credentialOnboarding: false
EOF
    echo "discovery fact=ui-settings-models.config.credentialOnboarding=false disables credential onboarding only"
    seeded=1
  else
    echo "discovery error=harness"
    probe_status=2
  fi
else
  echo "discovery error=harness"
  probe_status=2
fi
stop_instance discovery

prepare_trial_dirs preseed
write_overlay "${workdir}/preseed/patch.yml" webserver
if [ "$seeded" -eq 1 ]; then
  if seed_home "${trial_homes[preseed]}" "${workdir}/preseed-files"; then
    if start_instance preseed "${workdir}/preseed/patch.yml"; then
      run_trial_accept preseed "preseed-homepage.png" "method preseed"
    else
      echo "method preseed error=harness"
      probe_status=2
      mkdir -p "${workdir}/preseed" "${evidence}/preseed"
      printf '%s\n' "2" >"${workdir}/preseed/drive.status"
      printf '%s\n' "start" >"${workdir}/preseed/drive.reason"
      cp "${workdir}/preseed/drive.status" "${evidence}/preseed/drive.status"
      cp "${workdir}/preseed/drive.reason" "${evidence}/preseed/drive.reason"
    fi
  else
    echo "method preseed error=harness reason=seed"
    probe_status=2
    mkdir -p "${workdir}/preseed" "${evidence}/preseed"
    printf '%s\n' "2" >"${workdir}/preseed/drive.status"
    printf '%s\n' "seed" >"${workdir}/preseed/drive.reason"
    cp "${workdir}/preseed/drive.status" "${evidence}/preseed/drive.status"
    cp "${workdir}/preseed/drive.reason" "${evidence}/preseed/drive.reason"
  fi
else
  echo "method preseed error=harness reason=unseeded"
  probe_status=2
  mkdir -p "${workdir}/preseed" "${evidence}/preseed"
  printf '%s\n' "2" >"${workdir}/preseed/drive.status"
  printf '%s\n' "unseeded" >"${workdir}/preseed/drive.reason"
  cp "${workdir}/preseed/drive.status" "${evidence}/preseed/drive.status"
  cp "${workdir}/preseed/drive.reason" "${evidence}/preseed/drive.reason"
fi
stop_instance preseed

if ! capture_cli_help; then
  echo "method cli error=harness"
  probe_status=2
fi
prepare_trial_dirs cli
echo "method cli: no dedicated first-run flags; --patch is recorded under overlay, not a distinct recipe"

if [ "$seeded" -eq 1 ]; then
  prepare_trial_dirs combined
  write_overlay "${workdir}/combined/patch.yml" first-run
  if seed_home "${trial_homes[combined]}" "${workdir}/preseed-files"; then
    if start_instance combined "${workdir}/combined/patch.yml"; then
      run_trial_accept combined "combined-homepage.png" "combined"
    else
      echo "combined error=harness"
      probe_status=2
      mkdir -p "${workdir}/combined" "${evidence}/combined"
      printf '%s\n' "2" >"${workdir}/combined/drive.status"
      printf '%s\n' "start" >"${workdir}/combined/drive.reason"
      cp "${workdir}/combined/drive.status" "${evidence}/combined/drive.status"
      cp "${workdir}/combined/drive.reason" "${evidence}/combined/drive.reason"
    fi
  else
    echo "combined error=harness reason=seed"
    probe_status=2
    mkdir -p "${workdir}/combined" "${evidence}/combined"
    printf '%s\n' "2" >"${workdir}/combined/drive.status"
    printf '%s\n' "seed" >"${workdir}/combined/drive.reason"
    cp "${workdir}/combined/drive.status" "${evidence}/combined/drive.status"
    cp "${workdir}/combined/drive.reason" "${evidence}/combined/drive.reason"
  fi
  stop_instance combined
else
  mkdir -p "${workdir}/combined" "${evidence}/combined"
  printf '%s\n' "2" >"${workdir}/combined/drive.status"
  printf '%s\n' "unseeded" >"${workdir}/combined/drive.reason"
  cp "${workdir}/combined/drive.status" "${evidence}/combined/drive.status"
  cp "${workdir}/combined/drive.reason" "${evidence}/combined/drive.reason"
fi

run_composition_trial

set +e
python3 - "$workdir" "$evidence" "$probe_status" <<'PY'
import json, pathlib, shutil, sys
root = pathlib.Path(sys.argv[1])
evidence = pathlib.Path(sys.argv[2])
for source in root.glob("*/*.json"):
    shutil.copyfile(source, evidence / (source.parent.name + "-" + source.name))
goals = ("workspace", "language", "notice")

def load(path):
    if not path.exists():
        return None
    text = path.read_text().strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None

def drive_status(name):
    path = root / name / "drive.status"
    if not path.exists():
        return None
    return path.read_text().strip()

def trial_ok(name):
    return drive_status(name) == "0"

def goal_from_accept(name, data):
    status = drive_status(name)
    if status != "0":
        ui = (data or {}).get("ui") or {}
        return {g: "error" for g in goals} | {"accepted": False, "inputUsable": False, "initialized": False, "ui": ui}
    if not data or data.get("mode") != "accept":
        return {g: "error" for g in goals} | {"accepted": False, "inputUsable": False, "initialized": False}
    ui = data.get("ui") or {}
    if data.get("initialized") is False or ui.get("initialized") is False:
        return {g: "unknown" for g in goals} | {"accepted": False, "inputUsable": False, "initialized": False, "ui": ui}
    language = bool(ui.get("chinese"))
    notice = bool(ui.get("noNotice"))
    input_proof = data.get("input") or {}
    typed = bool(input_proof.get("typed") and input_proof.get("cleared"))
    if data.get("workBoundUnknown"):
        workspace = "unknown"
    else:
        workspace = "true" if bool(ui.get("workspaceSelected") and data.get("workBound")) else "false"
    return {
        "workspace": workspace,
        "language": "true" if language else "false",
        "notice": "true" if notice else "false",
        "accepted": bool(data.get("accepted")),
        "inputUsable": bool(ui.get("inputUsable")),
        "typed": typed,
        "initialized": True,
        "ui": ui,
    }

baseline = load(root / "baseline" / "observe.json")
methods = {
    "overlay": goal_from_accept("overlay", load(root / "overlay" / "accept.json")),
    "preseed": goal_from_accept("preseed", load(root / "preseed" / "accept.json")),
    "cli": {g: ("unsupported" if (evidence / "cli-help" / "status").exists() else "unknown") for g in goals} | {"accepted": False, "inputUsable": False},
    "composition": goal_from_accept("composition", load(root / "composition" / "accept.json")),
}
combined_row = goal_from_accept("combined", load(root / "combined" / "accept.json")) if (root / "combined").exists() else None
print("matrix")
if baseline:
    ui = (baseline.get("ui") or {})
    print(
        "  baseline workspaceChoice=%s workspaceSelected=%s lang=%s notice=%s editable=%s hostname=%s initialized=%s"
        % (
            ui.get("workspaceChoice"),
            ui.get("workspaceSelected"),
            ui.get("lang"),
            ui.get("notice"),
            ui.get("editable"),
            ui.get("hostname"),
            ui.get("initialized"),
        )
    )
for name, row in methods.items():
    print(
        "  %s workspace=%s language=%s notice=%s inputUsable=%s typed=%s"
        % (name, row["workspace"], row["language"], row["notice"], row.get("inputUsable"), row.get("typed"))
    )
if combined_row:
    print(
        "  combined workspace=%s language=%s notice=%s inputUsable=%s typed=%s"
        % (combined_row["workspace"], combined_row["language"], combined_row["notice"], combined_row.get("inputUsable"), combined_row.get("typed"))
    )
winners = {g: [] for g in goals}
errored = sys.argv[3] == "2"
for name, row in list(methods.items()) + ([("combined", combined_row)] if combined_row else []):
    for g in goals:
        if row[g] == "true":
            winners[g].append(name)
        elif row[g] in ("error", "unknown"):
            errored = True
print("winners workspace=%s language=%s notice=%s" % (winners["workspace"] or ["none"], winners["language"] or ["none"], winners["notice"] or ["none"]))
if errored:
    print("matrix inconclusive: harness error")
    print("evidence=%s" % evidence)
    sys.exit(2)
if any(not winners[g] for g in goals):
    print("无法做到")
    print("evidence=%s" % evidence)
    sys.exit(1)
combined = load(root / "combined" / "accept.json")
accepted = [(name, load(root / name / "accept.json")) for name in methods if trial_ok(name)]
if combined and trial_ok("combined"):
    accepted.append(("combined", combined))
recipes = [name for name, row in accepted if row and row.get("accepted") and row.get("initialized") is not False]
if not recipes:
    print("无法做到: no fresh complete recipe accepted")
    sys.exit(1)
for name in recipes:
    if name == "composition":
        print("accepted recipe=composition; deployed @dsh-team/zh-locale; canonical patch disables only ui-settings-models; fresh entry and refresh accepted")
    else:
        print("accepted recipe=%s; locale.preference=zh; ui-settings-general.welcomeNoticeVersion=2026-09-28.1; ui-settings-models.credentialOnboarding=false" % name)
    print("workspace files: %s" % sorted(str(path.relative_to(root / "preseed-files")) for path in (root / "preseed-files").rglob("*") if path.is_file()))
print("evidence=%s" % evidence)
sys.exit(0)
PY
status=$?
set -e
if [ "$probe_status" -eq 2 ]; then
  cleanup
  trap - EXIT INT TERM
  exit 2
fi
probe_status="$status"
cleanup
trap - EXIT INT TERM
exit "$probe_status"
