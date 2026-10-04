#!/usr/bin/env bash
# Sourced by probe-first-run.sh after the original method matrix and combined trial.
# Uses that caller's existing launch, seed, timeout, status, and cleanup boundaries.
# shellcheck disable=SC2154

run_composition_trial() {
  local status=0 version
  prepare_trial_dirs composition
  write_overlay "${workdir}/composition/patch.yml" webserver
  if [ "$seeded" -ne 1 ]; then
    printf '%s\n' unseeded >"${workdir}/composition/drive.reason"
    record_drive composition "${workdir}/composition/accept.json" 2 "composition"
    return 0
  fi
  if run_help_container "${prefix}-composition-pin" "${workdir}/composition/version.txt" dsh --version; then
    version="$(cat "${workdir}/composition/version.txt")"
  else
    version=""
  fi
  if [ "$version" != "0.2.0-rc.2" ]; then
    printf '%s\n' pin-mismatch >"${workdir}/composition/drive.reason"
    record_drive composition "${workdir}/composition/accept.json" 2 "composition"
    return 0
  fi
  if env PROBE_HOME="${trial_homes[composition]}" PROBE_DISCOVER_OUT="${workdir}/preseed-files" \
    PROBE_PLUGIN_DIR="${repo_root}/plugins/zh-locale" \
    PROBE_COMPOSITION_OVERLAY="${workdir}/composition/patch.yml" \
    node "$driver" prepare-composition >"${workdir}/composition/artifacts.json" &&
    probe_chown_tree "$image" "${trial_homes[composition]}" "${prefix}-composition-chown"; then
    cp "${workdir}/composition/artifacts.json" "${evidence}/composition-artifacts.json"
  else
    printf '%s\n' artifact-seed-or-registration >"${workdir}/composition/drive.reason"
    record_drive composition "${workdir}/composition/accept.json" 2 "composition"
    return 0
  fi
  if start_instance composition "${workdir}/composition/patch.yml"; then
    if drive_cmd composition accept-composition "composition-homepage.png" >"${workdir}/composition/accept.json"; then
      status=0
    else
      status=$?
    fi
    record_drive composition "${workdir}/composition/accept.json" "$status" "composition"
  else
    printf '%s\n' start-or-registration >"${workdir}/composition/drive.reason"
    record_drive composition "${workdir}/composition/accept.json" 2 "composition"
  fi
  stop_instance composition
}
