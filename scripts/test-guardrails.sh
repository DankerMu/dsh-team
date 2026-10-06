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

cd "$wt" || exit 1
if ! { git init --quiet . && git add -A &&
  git -c user.name=guardrails -c user.email=guardrails@localhost \
    commit --quiet -m "chore: fixture baseline"; }; then
  echo "FATAL: could not create the fixture repository" >&2
  exit 1
fi

pass=0
fail=0

restore() {
  git reset --quiet --hard
  git clean -fdq -e node_modules
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

# ── 2. Commit message ────────────────────────────────────────────────────────
expect_reject "commit message (\"bad message\")" "type may not be empty" \
  sh -c 'echo "bad message" | pnpm exec commitlint'

# ── 3. Test pairing ──────────────────────────────────────────────────────────
echo "export const orphan = 1;" >platform/src/orphan.ts
expect_reject "test pairing (orphan.ts has no test)" "without a sibling test file" \
  pnpm lint:tests

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

# ── 6. Shell lint, documented commands, format, types ────────────────────────
# shellcheck disable=SC2016 # the literal, unquoted $1 is the planted violation
printf '#!/usr/bin/env bash\necho $1\n' >scripts/unquoted.sh
expect_reject "shellcheck (unquoted expansion)" "SC2086" pnpm lint:shell

# shellcheck disable=SC2016 # literal Markdown backticks, not a command substitution
printf '\nRun `pnpm no-such-script` first.\n' >>AGENTS.md
expect_reject "documented commands (pnpm no-such-script)" "is not a script in package.json" \
  pnpm lint:agents

echo "export   const   spaced=1" >platform/src/spaced.ts
expect_reject "format (unformatted file)" "platform/src/spaced.ts" pnpm fmt:check

echo "export const count: number = 'three';" >platform/src/mistyped.ts
expect_reject "typecheck (string assigned to number)" "error TS2322" pnpm typecheck

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

# Fixed-size clones are diluted as platform/ grows. Count a conservative source
# corpus (including tests), then target twice the live percentage. Even counting
# only one copy as duplicated, N / (corpus + 2N) exceeds that target; the gate's
# own threshold, configuration and clean-tree acceptance remain unchanged.
duplicate_lines="$(node --input-type=module <<'NODE'
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
  .filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file));
let corpus = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text !== '') corpus += text.split('\n').length - Number(text.endsWith('\n'));
}
// Ten branch rows exceed the pinned detector's five-line/fifty-token minimum.
const rows = Math.max(10, Math.floor(target * corpus / (100 - 2 * target)) + 1);
process.stdout.write(`${rows}\n`);
NODE
)" || exit 1
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

echo "{}" >schemas/openapi.json
expect_reject "contract (stale schemas/openapi.json)" "out of date" pnpm contract:check

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
