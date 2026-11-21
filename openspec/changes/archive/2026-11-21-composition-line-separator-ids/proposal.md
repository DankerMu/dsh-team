# Composition reader: line-separator ids

## Why

The managed composition reader (`platform/src/managed-config/read.ts:54-56`) tolerates a profile/home row whose target is absent only when DSH's warning matches `/^patch: entry ".*" not found$/` as a whole. The released `@deepseek-ai/dsh-app-boot` 0.2.1-rc.2 formats that warning with `JSON.stringify(id)` (`lib/index.js:96-98`, `:1084-1089`), which does not escape U+2028/U+2029; without the `s` flag `.` does not match them, so such a row throws `Invalid managed composition` and the instance never starts, although DSH itself only skips the row. The spec scenario "profile 里目标不存在的行不阻止启动" (`openspec/specs/managed-config/spec.md:443-446`) promises the skip for any string id. Introduced in `3ef8ab7` (PR #640, #601). Issue #651.

## What Changes

- `read.ts`: the tolerated-warning test matches `patch: entry "<any JSON string>" not found` including line terminators (the `s` flag); the whitelist shape is unchanged, so every other warning — name mismatch, `patch insert` target absent or not a group, missing id, non-string id (`patch: entry 5 not found` has no `"` after `entry `) — still throws (non-string ids tested: number, object, array, boolean).
- `platform/test/managed-composition.integration.test.ts`: tolerated rows with U+2028 (profile) and U+2029 (home) ids, output identical to the composition without them; regressions: a name-mismatch row and a `patch insert` absent-target row whose ids contain U+2028 still reject; every existing case, including the non-string-id rejection, unchanged.
- Spec: the existing scenario already covers any string id (issue AC4); one scenario is still added because every change needs a delta, and it makes the line-separator case explicit. It goes to "预装插件的强制状态经覆盖层下发" making the line-separator case explicit; `platform/src/managed-config/README.md:9` wording checked and aligned if needed.

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: an over-broad match would tolerate a warning that must fail (a composition the platform cannot reason about would start); the whitelist shape and the regression cases pin this
Selected risk packs: Error handling; Legacy compatibility
Evidence floor: red-then-green integration cases; pnpm check; exact-head VPS pnpm test:docker + pnpm test:deploy (platform/src change; the reader runs inside the user image at start)
```

## Capabilities

### Modified Capabilities

- `managed-config`: the absent-target tolerance scenario is extended to ids containing U+2028/U+2029.

## Impact

- `platform/src/managed-config/read.ts` (generated reader script), its integration test, possibly `platform/src/managed-config/README.md`. Not a critical path. Out of scope: non-string id rejection (specified), the other four warnings, #601 direction B.
