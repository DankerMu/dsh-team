#!/usr/bin/env bash
# scripts/test-guardrails.sh — proves every blocking gate is live.
# For each gate: (1) it accepts the clean tree, (2) it rejects one planted
# violation and names the reason. A gate that exits non-zero without naming the
# reason crashed; a gate that is not runnable (exit 126/127) is phantom enforcement.
#
# Runs in a throwaway copy of the working tree (tracked + untracked, not ignored),
# so it tests the files as they are now, committed or not.
set -u

repo_root="$(git rev-parse --show-toplevel)" || exit 1
tmp="$(mktemp -d "${TMPDIR:-/tmp}/guardrails.XXXXXX")" || exit 1
tmp="$(cd "$tmp" && pwd -P)" || exit 1
wt="$tmp/wt"
mkdir -p "$wt"

fixture_strays() {
  ps -A -ww -o pid= -o args= | FIXTURE_ROOT="$tmp" awk 'index($0, ENVIRON["FIXTURE_ROOT"])'
}

cleanup() {
  cd "$repo_root" || exit 1
  strays="$(fixture_strays)"
  if [ -n "$strays" ]; then
    printf '%s\n' "$strays" | awk '{ print $1 }' | xargs kill -KILL 2>/dev/null
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

cd "$repo_root" || exit 1
git ls-files -co --exclude-standard -z |
  while IFS= read -r -d '' file; do
    [ -e "$file" ] && printf '%s\0' "$file"
  done |
  tar --null -T - -cf - | tar -xf - -C "$wt" || {
  echo "FATAL: could not copy the working tree into $wt" >&2
  exit 1
}
ln -s "$repo_root/node_modules" "$wt/node_modules"
ln -s "$repo_root/platform/node_modules" "$wt/platform/node_modules"
ln -s "$repo_root/platform/web/node_modules" "$wt/platform/web/node_modules"

cd "$wt" || exit 1
if ! { git init --quiet . && git add -A &&
  git -c user.name=guardrails -c user.email=guardrails@localhost \
    commit --quiet -m "chore: fixture baseline"; }; then
  echo "FATAL: could not create the fixture repository" >&2
  exit 1
fi
baseline="$(git rev-parse HEAD)"

pass=0
fail=0

restore() {
  git reset --quiet --hard
  git clean -fdq -e node_modules
}

# PR-range fixtures commit on top of the recorded baseline; every case resets to it.
range_restore() {
  git reset --quiet --hard "$baseline"
  git clean -fdq -e node_modules
}

# range_commit <message> <path>...: appends to each path (A when new, M when tracked).
range_commit() {
  message="$1"
  shift
  for file in "$@"; do
    mkdir -p "$(dirname "$file")" && printf 'fixture\n' >>"$file" || return 1
  done
  git add -- "$@" &&
    git -c user.name=guardrails -c user.email=guardrails@localhost commit --quiet -m "$message"
}

expect_accept() {
  name="$1"
  shift
  if out="$("$@" 2>&1)"; then
    echo "PASS  $name — accepts the clean tree"
    pass=$((pass + 1))
  else
    echo "FAIL  $name — REJECTED the clean tree (always-failing gate or broken setup):"
    printf '%s\n' "$out" | tail -n 15 | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}

expect_reject() {
  name="$1"
  reason="$2"
  shift 2
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "FAIL  $name — gate ACCEPTED the violation (phantom enforcement)"
    fail=$((fail + 1))
  elif [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo "FAIL  $name — gate not runnable (exit $rc): missing tool or non-executable script"
    fail=$((fail + 1))
  elif ! printf '%s\n' "$out" | grep -qF -- "$reason"; then
    echo "FAIL  $name — exited $rc without naming \"$reason\" — crash, not rejection:"
    printf '%s\n' "$out" | tail -n 15 | sed 's/^/        /'
    fail=$((fail + 1))
  else
    echo "PASS  $name — rejected the violation and named it (exit $rc)"
    pass=$((pass + 1))
  fi
  restore
}

lint_file() {
  pnpm exec eslint --max-warnings 0 "$1"
}

# ── 0. Every gate accepts the clean tree ─────────────────────────────────────
expect_accept "naming guard" bash .git-hooks/check-naming.sh
expect_accept "test pairing" pnpm lint:tests
expect_accept "eslint" pnpm exec eslint . --max-warnings 0
expect_accept "module boundaries" pnpm lint:deps
expect_accept "shellcheck" pnpm lint:shell
expect_accept "documented commands" pnpm lint:agents
expect_accept "configuration inventory" pnpm lint:config
expect_accept "CI concurrency" pnpm lint:ci
expect_accept "format" pnpm fmt:check
expect_accept "typecheck" pnpm typecheck
expect_accept "coverage" pnpm test
expect_accept "duplicate code" pnpm duplicate-code
expect_accept "dead code" pnpm dead-code
expect_accept "contract" pnpm contract:check
expect_accept "secret scan" gitleaks git --pre-commit --staged --redact --no-banner
expect_accept "commit message" sh -c 'echo "feat(platform): add health route" | pnpm exec commitlint'

# ── 1. Naming and scratchpad guards ──────────────────────────────────────────
echo "export const value = 1;" >platform/src/session_v2.ts
git add platform/src/session_v2.ts
expect_reject "naming guard (session_v2.ts)" "forbidden naming suffix" \
  bash .git-hooks/check-naming.sh

mkdir -p scratch
echo "note" >scratch/note.txt
git add scratch/note.txt
expect_reject "scratchpad guard (scratch/)" "scratchpad directory" \
  bash .git-hooks/check-naming.sh

archive_root="openspec/changes/archive/2026-10-13-stabilize-browser-runtime-verification"
# Real archives may already be tracked. The hook scans additions/renames, so
# every planted archive artifact must start outside the tracked baseline.
while [ -e "$archive_root" ] || [ -L "$archive_root" ]; do
  archive_root="${archive_root}-guardrail"
done
for artifact in tasks.md .openspec.yaml specs/browser-runtime-verification/spec.md; do
  archive_path="$archive_root/$artifact"
  expect_accept "OpenSpec archive argument ($artifact)" bash .git-hooks/check-naming.sh "$archive_path"
  mkdir -p "$(dirname "$archive_path")"
  printf 'fixture\n' >"$archive_path"
  git add "$archive_path"
  expect_accept "OpenSpec archive staged ($artifact)" bash .git-hooks/check-naming.sh
  restore
done

for invalid_path in \
  archive/proposal.md \
  docs/openspec/changes/archive/2026-10-13-example/tasks.md \
  openspec/changes/archive/example/tasks.md \
  openspec/changes/archive/2026-1-13-example/tasks.md \
  openspec/changes/archive/2026-10-13-bad--name/tasks.md \
  "$archive_root" \
  "$archive_root/scratch/proposal.md" \
  "$archive_root/backup/proposal.md" \
  "$archive_root/archive/proposal.md" \
  "$archive_root/specs/session_v2.md"; do
  expect_reject "archive argument rejects $invalid_path" "naming violation" \
    bash .git-hooks/check-naming.sh "$invalid_path"
  mkdir -p "$(dirname "$invalid_path")"
  printf 'fixture\n' >"$invalid_path"
  git add "$invalid_path"
  reason="scratchpad directory"
  case "$invalid_path" in *_v2.md) reason="forbidden naming suffix" ;; esac
  expect_reject "archive staged rejects $invalid_path" "$reason" bash .git-hooks/check-naming.sh
done

for alias_path in "$archive_root/./tasks.md" "$archive_root/../tasks.md"; do
  expect_reject "archive argument rejects dot segment $alias_path" "naming violation" \
    bash .git-hooks/check-naming.sh "$alias_path"
done

mkdir -p "$archive_root" zzz/archive
printf 'fixture\n' >"$archive_root/tasks.md"
printf 'fixture\n' >zzz/archive/unrelated.md
git add "$archive_root/tasks.md" zzz/archive/unrelated.md
expect_reject "allowed archive never accepts a mixed invalid index" \
  "scratchpad directory:    zzz/archive/unrelated.md" bash .git-hooks/check-naming.sh

for missing_policy in setting file; do
  for mode in argument staged range; do
    if [ "$missing_policy" = file ]; then
      rm constraints.yaml
    else
      node --input-type=module -e 'import fs from "node:fs"; const path="constraints.yaml"; fs.writeFileSync(path,fs.readFileSync(path,"utf8").split("\n").filter(line=>!line.trimStart().startsWith("managed_archive_pattern:")).join("\n"));'
    fi
    if [ "$mode" = argument ]; then
      expect_reject "archive missing $missing_policy argument" "naming violation" \
        bash .git-hooks/check-naming.sh "$archive_root/tasks.md"
    elif [ "$mode" = range ]; then
      # Commits only the archive file: the policy edit stays in the working tree.
      if range_commit "docs(openspec): archive a change" "$archive_root/tasks.md"; then
        expect_reject "archive missing $missing_policy range" "scratchpad directory" \
          bash .git-hooks/check-naming.sh --range "$baseline" HEAD
      else
        echo "FAIL  archive missing $missing_policy range — could not build the fixture range"
        fail=$((fail + 1))
      fi
      range_restore
    else
      mkdir -p "$archive_root"
      printf 'fixture\n' >"$archive_root/tasks.md"
      git add "$archive_root/tasks.md"
      expect_reject "archive missing $missing_policy staged" "scratchpad directory" \
        bash .git-hooks/check-naming.sh
    fi
  done
done

# Docker-evidence docs-only classifier: stdin is the changed-path list (#664).
docs_only() {
  printf '%s\n' "$@" | bash scripts/docs-only-diff.sh
}

stage2_change="stage-2-dsh-ragflow-office"
expect_accept "docs-only (OpenSpec archive with change metadata)" docs_only \
  "openspec/changes/archive/2026-11-20-$stage2_change/.openspec.yaml" \
  "openspec/changes/archive/2026-11-20-$stage2_change/proposal.md" \
  "openspec/changes/archive/2026-11-20-$stage2_change/specs/trusted-docker-verification/spec.md" \
  "openspec/changes/$stage2_change/.openspec.yaml" \
  "openspec/changes/$stage2_change/proposal.md" \
  "openspec/specs/trusted-docker-verification/spec.md"
expect_accept "docs-only (active change with metadata)" docs_only \
  openspec/changes/foo-bar/.openspec.yaml openspec/changes/foo-bar/proposal.md
expect_accept "docs-only (Markdown outside plugins/ and images/)" docs_only \
  docs/X.md docs/plugins/x.md

for offending in \
  plugins/x/README.md \
  images/dsh-user/x.md \
  images/dsh-user/openspec/changes/foo/.openspec.yaml \
  docs/openspec/changes/foo/.openspec.yaml \
  docs/openspec/changes/archive/2026-11-20-foo/.openspec.yaml \
  openspec/config.yaml \
  openspec/changes/foo/fixture.yaml \
  openspec/changes/archive/.openspec.yaml \
  openspec/changes/archive/2026-11-20-foo/specs/.openspec.yaml \
  openspec/changes/archive/2026-1-1-x/.openspec.yaml \
  openspec/changes/foo/specs/.openspec.yaml \
  openspec/changes/Foo/.openspec.yaml \
  openspec/changes/bad--name/.openspec.yaml \
  docs/.openspec.yaml; do
  expect_reject "docs-only rejects $offending" "evidence required: $offending" \
    docs_only docs/a.md "$offending"
done
expect_reject "docs-only rejects a mixed code list" "evidence required: platform/src/x.ts" \
  docs_only docs/a.md platform/src/x.ts
expect_reject "docs-only rejects an empty diff" "evidence required: empty diff" docs_only

# expect_reject cannot tell "evidence required" (1) from a classifier failure (2).
for missing_policy in setting file; do
  if [ "$missing_policy" = file ]; then
    rm constraints.yaml
  else
    grep -v 'managed_archive_pattern:' constraints.yaml >constraints.yaml.fixture
    mv constraints.yaml.fixture constraints.yaml
  fi
  err="$(docs_only docs/a.md 2>&1 >/dev/null)"
  rc=$?
  if [ "$rc" -eq 2 ] && printf '%s\n' "$err" | grep -qF managed_archive_pattern; then
    echo "PASS  docs-only missing $missing_policy — failed as configuration error (exit 2)"
    pass=$((pass + 1))
  else
    echo "FAIL  docs-only missing $missing_policy — exited $rc, want 2 naming managed_archive_pattern:"
    printf '%s\n' "$err" | tail -n 15 | sed 's/^/        /'
    fail=$((fail + 1))
  fi
  restore
done
# expect_reject accepts any nonzero exit; these pin the classifier's exact code.
expect_exit() {
  name="$1"
  want="$2"
  reason="$3"
  shift 3
  out="$("$@" 2>&1)"
  rc=$?
  if [ "$rc" -eq "$want" ] && printf '%s\n' "$out" | grep -qF -- "$reason"; then
    echo "PASS  $name — exit $rc naming \"$reason\""
    pass=$((pass + 1))
  else
    echo "FAIL  $name — exited $rc, want $want naming \"$reason\":"
    printf '%s\n' "$out" | tail -n 15 | sed 's/^/        /'
    fail=$((fail + 1))
  fi
  restore
}
expect_exit "docs-only empty diff" 1 "evidence required: empty diff" docs_only
expect_exit "docs-only code path" 1 "evidence required: platform/src/x.ts" docs_only platform/src/x.ts
sed 's|^\(    managed_archive_pattern: \).*|\1"^openspec/(["|' constraints.yaml >constraints.yaml.fixture
mv constraints.yaml.fixture constraints.yaml
expect_exit "docs-only invalid managed_archive_pattern" 2 \
  "managed_archive_pattern in constraints.yaml is not a valid regex" docs_only docs/a.md

# The Docker-evidence scope step's own run: text from ci.yml, fed PR-controlled
# file names: path-derived output must sit inside stop-commands markers (#664 S1).
scope_step="$tmp/scope-step.sh"
scope_repo="$tmp/scope-repo"
node --input-type=module - "$scope_step" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
const step = steps.find((candidate) => candidate.name === 'Detect documentation-only change');
writeFileSync(process.argv[2], step?.run ?? '');
JS
# stdin: step log. WANT: verdict lines that must be wrapped. Prints the token.
scope_wrapped() {
  awk '
    BEGIN { n = split(ENVIRON["WANT"], want, "\n"); for (i = 1; i <= n; i++) need[want[i]] = 1 }
    /^::stop-commands::/ { if (state) bad = bad " second stop;"; state = 1; tok = substr($0, 18); next }
    state == 1 && $0 == "::" tok "::" { state = 2; next }
    state == 1 { seen[$0] = 1; next }
    /##\[|::/ { bad = bad " unwrapped: " $0 ";" }
    END {
      if (state != 2) bad = bad " no matching resume;"
      if (length(tok) != 32 || tok ~ /[^0-9a-f]/) bad = bad " token not 32 hex;"
      for (line in need) if (!(line in seen)) bad = bad " not wrapped: " line ";"
      if (bad != "") { print bad; exit 1 }
      print tok
    }'
}
scope_case() {
  name="$1"
  want_output="$2"
  want_wrapped="$3"
  shift 3
  if ! (
    rm -rf "$scope_repo" && mkdir -p "$scope_repo/scripts" &&
      cp scripts/docs-only-diff.sh scripts/constraints-yaml.sh "$scope_repo/scripts/" &&
      cp constraints.yaml "$scope_repo/" && cd "$scope_repo" && git init --quiet . && git add -A &&
      git -c user.name=guardrails -c user.email=guardrails@localhost commit --quiet -m base &&
      for file in "$@"; do mkdir -p "$(dirname "$file")" && echo x >"$file" || exit 1; done &&
      git add -A && git -c user.name=guardrails -c user.email=guardrails@localhost commit --quiet -m range
  ); then
    echo "FAIL  $name — could not build the fixture repository"
    fail=$((fail + 1))
    return
  fi
  : >"$tmp/scope-output"
  log="$(cd "$scope_repo" && RANGE='HEAD~1...HEAD' GITHUB_OUTPUT="$tmp/scope-output" \
    bash --noprofile --norc -eo pipefail "$scope_step" 2>&1)"
  rc=$?
  token="$(printf '%s\n' "$log" | WANT="$want_wrapped" scope_wrapped)"
  wrapped=$?
  problem=""
  if ! grep -qF docs-only-diff.sh "$scope_step"; then
    problem="step text not extracted from ci.yml"
  elif [ "$rc" -ne 0 ]; then
    problem="step exited $rc"
  elif ! if [ -n "$want_output" ]; then printf '%s\n' "$want_output"; fi | cmp -s - "$tmp/scope-output"; then
    problem="GITHUB_OUTPUT is not \"$want_output\": $(cat "$tmp/scope-output")"
  elif [ "$wrapped" -ne 0 ]; then
    problem="$token"
  elif printf '%s\n' "$@" | grep -qF -- "$token"; then
    problem="token occurs in the input"
  elif [ "$token" = "${scope_token:-}" ]; then
    problem="token reused across runs"
  fi
  scope_token="$token"
  if [ -z "$problem" ]; then
    echo "PASS  $name — verdict wrapped by token $token"
    pass=$((pass + 1))
  else
    echo "FAIL  $name — $problem"
    printf '%s\n' "$log" | tail -n 15 | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}
injected='##[set-output name=docs_only;]true'
scope_case "scope step wraps an injected evidence-required name" "" \
  "evidence required: $injected" "$injected" platform/a.ts
scope_case "scope step wraps a docs-only listing" "docs_only=true" \
  "docs-only
docs/##[error]injected.md
docs/a.md
openspec/changes/foo/.openspec.yaml" \
  'docs/##[error]injected.md' docs/a.md openspec/changes/foo/.openspec.yaml
# Distinct PR deliveries must retain their own checks, even in the pending queue.
for policy in shared cancel-disabled action-only malformed main-cancel; do
  restore
  node --input-type=module - "$policy" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
const path = '.github/workflows/ci.yml';
const workflow = parse(readFileSync(path, 'utf8'));
const mode = process.argv[2];
const shared = '${{ github.workflow }}-${{ github.ref }}';
if (mode === 'shared' || mode === 'cancel-disabled') {
  workflow.concurrency = { group: shared, 'cancel-in-progress': mode === 'shared' };
} else if (mode === 'action-only') {
  workflow.concurrency = { group: `${shared}-${'${{ github.event.action }}'}`, 'cancel-in-progress': false };
} else if (mode === 'malformed') {
  workflow.concurrency.group = '${{ github.workflow broken }}';
} else {
  workflow.concurrency['cancel-in-progress'] = true;
}
writeFileSync(path, stringify(workflow));
JS
  case "$policy" in
    malformed) reason="CI concurrency invalid policy" ;;
    main-cancel) reason="CI main concurrency changed" ;;
    *) reason="CI PR concurrency collision" ;;
  esac
  expect_reject "CI concurrency ($policy)" "$reason" pnpm lint:ci
done
restore
expect_accept "CI concurrency (restored)" pnpm lint:ci


# ── 2. Commit message ────────────────────────────────────────────────────────
expect_reject "commit message (\"bad message\")" "type may not be empty" \
  sh -c 'echo "bad message" | pnpm exec commitlint'

# The CI layer: `pnpm lint:pr <base> <head>` gates only the range's own commits
# and added/renamed paths, and fails closed on an unreadable range (#665).
# range_case <name> <setup> <expect_* args...>: a failed setup is a failure, and
# the fixture never outlives the case.
range_case() {
  name="$1"
  setup="$2"
  shift 2
  if "$setup"; then
    "$@"
  else
    echo "FAIL  $name — could not build the fixture range"
    fail=$((fail + 1))
  fi
  range_restore
}
long_subject="feat(platform): add a commit subject that deliberately runs well past the seventy-two character limit"
range_overlong() { range_commit "$long_subject" docs/guardrails-range.md; }
range_suffix() { range_commit "feat(platform): add a session fixture" platform/src/session_v2.ts; }
range_scratch() { range_commit "docs(repo): add a note" tmp/note.md; }
range_archive() { range_commit "docs(openspec): archive a change" "$archive_root/tasks.md"; }
range_case "PR range (overlong subject)" range_overlong \
  expect_reject "PR range (overlong subject)" "subject-max-length" pnpm lint:pr "$baseline" HEAD
range_case "PR range (adds session_v2.ts)" range_suffix \
  expect_reject "PR range (adds session_v2.ts)" "forbidden naming suffix" pnpm lint:pr "$baseline" HEAD
range_case "PR range (adds tmp/)" range_scratch \
  expect_reject "PR range (adds tmp/)" "scratchpad directory" pnpm lint:pr "$baseline" HEAD
range_case "PR range (adds a managed archive file)" range_archive \
  expect_accept "PR range (adds a managed archive file)" pnpm lint:pr "$baseline" HEAD

# Base history holds an overlong subject and a forbidden path; the range modifies
# that path (M), merges a side commit under a default-ignored message, and conforms.
range_history() {
  range_commit "$long_subject" tmp/session_v2.md || return 1
  history_base="$(git rev-parse HEAD)" || return 1
  range_commit "docs(repo): add a side note" docs/guardrails-side.md || return 1
  side="$(git rev-parse HEAD)" || return 1
  git reset --quiet --hard "$history_base" &&
    range_commit "docs(repo): extend the base note" tmp/session_v2.md &&
    git -c user.name=guardrails -c user.email=guardrails@localhost \
      merge --quiet --no-ff -m "Merge branch 'side'" "$side"
}
# Reads history_base when run, after range_history has set it.
lint_history() { pnpm lint:pr "$history_base" HEAD; }
range_case "PR range (base history is not the range's)" range_history \
  expect_accept "PR range (base history is not the range's)" lint_history

# Unreadable ranges fail closed with the fixed reason; never read as empty.
if ! orphan="$(printf 'chore: unrelated root\n' |
  git -c user.name=guardrails -c user.email=guardrails@localhost commit-tree "$baseline^{tree}")"; then
  echo "FAIL  PR range (no merge base) — could not build the unrelated root"
  fail=$((fail + 1))
fi
missing_sha="0000000000000000000000000000000000000000"
expect_reject "PR range (one argument)" "lint:pr: unreadable range" pnpm lint:pr "$baseline"
expect_reject "PR range (unknown head)" "lint:pr: unreadable range" pnpm lint:pr "$baseline" "$missing_sha"
expect_reject "PR range (no merge base)" "lint:pr: unreadable range" pnpm lint:pr "$baseline" "$orphan"
expect_reject "naming range (unknown head)" "check-naming.sh: unreadable range" \
  bash .git-hooks/check-naming.sh --range "$baseline" "$missing_sha"

# ── 3. Test pairing ──────────────────────────────────────────────────────────
echo "export const orphan = 1;" >platform/src/orphan.ts
expect_reject "test pairing (orphan.ts has no test)" "without a sibling test file" \
  pnpm lint:tests

echo "export const orphan = 1;" >platform/web/src/orphan.tsx
expect_reject "web test pairing (TSX behavior has no sibling test)" "without a sibling test file" \
  pnpm lint:tests

echo "export const orphan = 1;" >plugins/office-agents/orphan.js
expect_reject "office plugin test pairing (JS behavior has no sibling test)" "without a sibling test file" \
  pnpm lint:tests

echo "export const orphan = 1;" >plugins/knowledge-base/orphan.js
expect_reject "knowledge-base plugin test pairing (JS behavior has no sibling test)" \
  "plugins/knowledge-base/orphan.js" pnpm lint:tests

echo "export const orphan = 1;" >plugins/office-hints/orphan.js
expect_reject "office-hints plugin test pairing (JS behavior has no sibling test)" \
  "plugins/office-hints/orphan.js" pnpm lint:tests

echo "export const orphan = 1;" >images/dsh-user/orphan.mjs
expect_reject "user-image script test pairing (MJS behavior has no sibling test)" \
  "images/dsh-user/orphan.mjs" pnpm lint:tests

# ── 4. ESLint: size, complexity, logging, identifier naming ──────────────────
max_lines="$(node scripts/constraints.mjs size_limits max_file_lines)"
{
  i=0
  while [ "$i" -le "$max_lines" ]; do
    echo "export const line${i} = ${i};"
    i=$((i + 1))
  done
} >platform/src/oversized.ts
expect_reject "eslint max-lines ($((max_lines + 1)) lines)" "Maximum allowed is ${max_lines}" \
  lint_file platform/src/oversized.ts

max_complexity="$(node scripts/constraints.mjs size_limits max_complexity)"
{
  echo "export function branchy(input: number): number {"
  echo "  let total = 0;"
  i=0
  while [ "$i" -le "$max_complexity" ]; do
    echo "  if (input === ${i}) total += ${i};"
    i=$((i + 1))
  done
  echo "  return total;"
  echo "}"
} >platform/src/branchy.ts
expect_reject "eslint complexity ($((max_complexity + 2)) paths)" "Maximum allowed is ${max_complexity}" \
  lint_file platform/src/branchy.ts

echo "console.log('debug');" >platform/src/noisy.ts
expect_reject "eslint no-console" "no-console" lint_file platform/src/noisy.ts

echo "export const deadline = Date.now() + 5000;" >platform/test/bare-deadline.integration.test.ts
expect_reject "eslint bare integration deadline" "Bare integration-test deadline" \
  lint_file platform/test/bare-deadline.integration.test.ts

echo "export const session_v2 = 1;" >platform/src/renamed.ts
expect_reject "eslint identifier suffix (session_v2)" "naming-convention" \
  lint_file platform/src/renamed.ts

echo "export class GatewayLegacy {}" >platform/src/gateway.ts
expect_reject "eslint type suffix (GatewayLegacy)" "naming-convention" \
  lint_file platform/src/gateway.ts

# ── 5. Module boundaries ─────────────────────────────────────────────────────
mkdir -p platform/src/alpha platform/src/beta
echo "export const secret = 1;" >platform/src/alpha/secret.ts
echo "export { secret } from './secret.ts';" >platform/src/alpha/index.ts
echo "export { secret } from '../alpha/secret.ts';" >platform/src/beta/index.ts
expect_reject "module boundary (beta imports alpha internals)" "module-internals-are-private" \
  pnpm lint:deps

echo "import { right } from './right.ts'; export const left = right;" >platform/src/left.ts
echo "import { left } from './left.ts'; export const right = left;" >platform/src/right.ts
expect_reject "module boundary (import cycle)" "no-circular" pnpm lint:deps

echo "import { DatabaseSync } from 'node:sqlite'; export const db = DatabaseSync;" \
  >platform/src/storage.ts
expect_reject "module boundary (SQLite outside db/)" "only-db-touches-sqlite" pnpm lint:deps

mkdir -p plugins/sample/src
echo "export const pluginValue = 1;" >plugins/sample/src/value.ts
echo "export { pluginValue } from '../../plugins/sample/src/value.ts';" >platform/src/bridge.ts
expect_reject "module boundary (platform imports plugins)" "platform-and-plugins-are-separate" \
  pnpm lint:deps

echo "export { buildApp } from '../../src/app.ts';" >platform/web/src/server-import.ts
expect_reject "module boundary (browser imports backend)" "browser-sources-are-isolated" \
  pnpm lint:deps

echo "import { readFile } from 'node:fs'; export const read = readFile;" >platform/web/src/node-import.ts
expect_reject "module boundary (browser imports Node)" "browser-sources-have-no-node-builtins" \
  pnpm lint:deps

echo "export { unused } from '../web/src/unused.ts';" >platform/src/browser-import.ts
echo "export const unused = 1;" >platform/web/src/unused.ts
expect_reject "module boundary (backend imports browser source)" "backend-does-not-import-browser" \
  pnpm lint:deps

# ── 6. Shell lint, documented commands, format, types ────────────────────────
# shellcheck disable=SC2016 # the literal, unquoted $1 is the planted violation
printf '#!/usr/bin/env bash\necho $1\n' >scripts/unquoted.sh
expect_reject "shellcheck (unquoted expansion)" "SC2086" pnpm lint:shell

node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'package.json';
const manifest = JSON.parse(readFileSync(path, 'utf8'));
for (let index = 0; index < 16000; index += 1) {
  manifest.scripts[`inventory-probe-${index}`] = 'node --version';
}
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
NODE
expect_accept "documented commands (large valid inventory)" pnpm lint:agents
restore

node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'package.json';
const manifest = JSON.parse(readFileSync(path, 'utf8'));
manifest.scripts['no-such-script-extra'] = 'node --version';
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
NODE
# shellcheck disable=SC2016 # literal Markdown backticks, not a command substitution
printf '\nRun `pnpm no-such-script` first.\n' >>AGENTS.md
expect_reject "documented commands (pnpm no-such-script)" "is not a script in package.json" \
  pnpm lint:agents
restore

# Module READMEs indexed by AGENTS.md are part of the documented command surface.
# shellcheck disable=SC2016 # literal Markdown backticks, not a command substitution
printf '\nRun `pnpm no-such-readme-script` first.\n' >>platform/src/gateway/README.md
expect_reject "documented commands (module README)" '"pnpm no-such-readme-script" is not a script' \
  pnpm lint:agents
rm platform/src/gateway/README.md
expect_reject "documented commands (missing module README)" "platform/src/gateway/README.md is missing" \
  pnpm lint:agents
restore

echo "export   const   spaced=1" >platform/src/spaced.ts
expect_reject "format (unformatted file)" "platform/src/spaced.ts" pnpm fmt:check

echo "export const count: number = 'three';" >platform/src/mistyped.ts
expect_reject "typecheck (string assigned to number)" "error TS2322" pnpm typecheck

echo "export const count: number = 'three';" >platform/web/src/mistyped.tsx
expect_reject "web typecheck (TSX string assigned to number)" "error TS2322" pnpm typecheck

# ── 7. Coverage, duplicates, dead code, contract ─────────────────────────────
cat >platform/src/bare.ts <<'EOF'
export function covered(): number {
  return 1;
}
export function uncovered(input: number): number {
  if (input > 0) return input * 2;
  return input - 1;
}
EOF
cat >platform/src/bare.test.ts <<'EOF'
import { expect, it } from 'vitest';
import { covered } from './bare.ts';

it('covers one of two functions', () => {
  expect(covered()).toBe(1);
});
EOF
expect_reject "coverage (bare.ts below the per-file threshold)" "bare.ts" pnpm test

cat >platform/web/src/bare.tsx <<'EOF'
export function sign(input: number): number {
  return input > 0 ? 1 : -1;
}
EOF
cat >platform/web/src/bare.test.tsx <<'EOF'
import { expect, it } from 'vitest';
import { sign } from './bare.tsx';

it('covers only the positive client branch', () => {
  expect(sign(3)).toBe(1);
});
EOF
expect_reject "web coverage (TSX branch below the per-file threshold)" "bare.tsx" pnpm test

# Fixed-size clones are diluted as platform/ grows. Count a conservative corpus:
# the ts/js/tsx files under platform/ minus exactly the tests jscpd.json ignores,
# so it is never smaller than the set the gate scans. jscpd.json's ignore list and
# this filter change together. Target twice the live percentage: even counting
# only one copy as duplicated, N / (corpus + 2N) exceeds that target; the gate's
# own threshold and clean-tree acceptance remain unchanged.
# Bash 3.2 misparses literal quotes in heredocs nested inside command substitution.
# Keep the program intact and let the existing temporary-root trap own its output.
node --input-type=module >"$tmp/duplicate-lines" <<'NODE' || exit 1
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constraintNumber } from './scripts/constraints.mjs';

const threshold = constraintNumber('anti_drift', 'duplicate_code_threshold_percent');
const target = 2 * threshold;
if (threshold < 0 || target >= 50) {
  throw new Error('Cannot size a two-copy duplicate canary for this percentage threshold');
}
const files = execFileSync('git', ['ls-files', '-z', '--', 'platform'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !/\.test\.tsx?$/.test(file));
let corpus = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text !== '') corpus += text.split('\n').length - Number(text.endsWith('\n'));
}
// Ten branch rows exceed the pinned detector's five-line/fifty-token minimum.
const rows = Math.max(10, Math.floor(target * corpus / (100 - 2 * target)) + 1);
process.stdout.write(`${rows}\n`);
NODE
IFS= read -r duplicate_lines <"$tmp/duplicate-lines" || exit 1
{
  echo "export function copied(input: number): number {"
  i=0
  while [ "$i" -lt "$duplicate_lines" ]; do
    echo "  if (input === ${i}) return input + ${i} * 2;"
    i=$((i + 1))
  done
  echo "  return input;"
  echo "}"
} >platform/src/first.ts
cp platform/src/first.ts platform/src/second.ts
expect_reject "duplicate code (two identical ${duplicate_lines}-branch corpus-sized functions)" "threshold" \
  pnpm duplicate-code

echo "export const neverImported = 1;" >>platform/src/health.ts
expect_reject "dead code (unused export)" "neverImported" pnpm dead-code

# Reach a browser module through the real Vite entry, but never consume its export.
# This catches a lost workspace/entry traversal, not merely a backend-only Knip run.
echo "export const neverImportedWeb = 1;" >platform/web/src/dead-code-canary.ts
echo "import './dead-code-canary.ts';" >>platform/web/src/main.tsx
expect_reject "web dead code (unused export)" "neverImportedWeb" pnpm dead-code

echo "{}" >schemas/openapi.json
expect_reject "contract (stale schemas/openapi.json)" "out of date" pnpm contract:check

# Configuration consumer inventories must match the single example in both directions.
echo 'PLATFORM_UNUSED=sentinel' >>.env.example
expect_reject "unused platform setting" "unconsumed PLATFORM_UNUSED" pnpm lint:config
echo 'DEPLOY_UNUSED=sentinel' >>.env.example
expect_reject "unused deployment setting" "unconsumed DEPLOY_UNUSED" pnpm lint:config
echo 'DOCUMENT_SERVER_UNUSED=sentinel' >>.env.example
expect_reject "unused Document Server setting" "unconsumed DOCUMENT_SERVER_UNUSED" pnpm lint:config
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'platform/src/config.ts';
writeFileSync(path, readFileSync(path, 'utf8').replace(
  'const publicOrigin =', 'void env["PLATFORM_UNDOCUMENTED"]; const publicOrigin =',
));
NODE
expect_reject "undocumented platform read" "undocumented PLATFORM_UNDOCUMENTED" pnpm lint:config
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'platform/src/config.ts';
writeFileSync(path, readFileSync(path, 'utf8').replace(
  'const publicOrigin =', 'void env.DOCUMENT_SERVER_UNDOCUMENTED; const publicOrigin =',
));
NODE
expect_reject "undocumented Document Server platform read" "undocumented DOCUMENT_SERVER_UNDOCUMENTED" \
  pnpm lint:config
echo "    x-inventory: \${DEPLOY_UNDOCUMENTED:?}" >>deploy/compose.yml
expect_reject "undocumented deployment interpolation" "undocumented DEPLOY_UNDOCUMENTED" pnpm lint:config
echo "    x-inventory: \${DOCUMENT_SERVER_UNDOCUMENTED:?}" >>deploy/compose.yml
expect_reject "undocumented Document Server interpolation" "undocumented DOCUMENT_SERVER_UNDOCUMENTED" \
  pnpm lint:config
echo "    labels: { inventory: \"\${DEPLOY_UNDOCUMENTED}\", other: \"fixed\" }" >>deploy/compose.yml
expect_reject "flow mapping inventory" "does not support flow collections" pnpm lint:config
echo "    group_add: [\"\${DEPLOY_UNDOCUMENTED}\", \"1000\"]" >>deploy/compose.yml
expect_reject "flow sequence inventory" "does not support flow collections" pnpm lint:config
printf '    environment:\n      INVENTORY: |2 # comment\n        value: \044{DEPLOY_UNDOCUMENTED}\n' >>deploy/compose.yml
expect_reject "commented block scalar inventory" "does not support block scalars" pnpm lint:config
echo '// env.PLATFORM_COMMENT;' >>platform/src/config.ts
echo 'const message = "env.PLATFORM_ERROR";' >>platform/src/config.ts
echo '# PLATFORM_COMMENT=unused' >>.env.example
echo "# \${DEPLOY_COMMENT}" >>deploy/compose.yml
echo "    x-inventory: \"\$\${DEPLOY_ESCAPED}\" # \${DEPLOY_COMMENT}" >>deploy/compose.yml
expect_accept "inventory ignores comments and escaped interpolation" pnpm lint:config
restore
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'platform/src/config.ts';
writeFileSync(path, readFileSync(path, 'utf8').replace(
  'const publicOrigin =', 'void env[configurationKey]; const publicOrigin =',
));
NODE
expect_reject "dynamic environment read" "requires literal PLATFORM_* or DOCUMENT_SERVER_*" \
  pnpm lint:config

# ── 8. Secret scan ───────────────────────────────────────────────────────────
# Assembled at run time so this script never contains a matchable secret.
fake_token="ghp_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 36)"
echo "export const token = '${fake_token}';" >platform/src/leak.ts
git add platform/src/leak.ts
expect_reject "secret scan (staged token)" "leaks found" \
  gitleaks git --pre-commit --staged --redact --no-banner

# ── 9. Residue ───────────────────────────────────────────────────────────────
strays="$(fixture_strays)"
if [ -n "$strays" ]; then
  echo "FAIL  processes outlived the run:"
  printf '%s\n' "$strays" | sed 's/^/        /'
  fail=$((fail + 1))
else
  echo "PASS  no process naming the fixture root outlived the run"
  pass=$((pass + 1))
fi

echo
echo "guardrail self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
