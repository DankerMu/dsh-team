# Design

## Context

`managedCompositionCommand` (`platform/src/managed-config/read.ts:20`) emits a Node script that runs inside the user image at every instance start. During the full-layer composition its warn callback tolerates exactly one DSH warning, `patch: entry <JSON id> not found`, for profile/home rows, and throws `Invalid managed composition` for everything else.

## Decision

Add the `s` flag to `/^patch: entry ".*" not found$/`.

- `JSON.stringify` escapes `"`, `\`, `\n`, `\r` and lone surrogates but not U+2028/U+2029; with `s`, `.` matches them, so every JSON string id matches.
- The pattern stays anchored: `^` plus the literal `patch: entry "` prefix excludes every other template (`patch insert: …`, name mismatch, missing id) and non-string ids (`5`, objects, arrays, booleans have no `"` after `entry `). Without `m`, `$` anchors only at the end of input, so a trailing extra line still fails.
- An id whose JSON text contains `" not found` cannot fake the ending: its inner `"` is escaped.

Rejected: a structural check (`startsWith`/`endsWith` plus `JSON.parse` of the middle). It states "string id" more exactly but adds generated-script lines and still depends on the same wording; the flag is the smaller change with the same whitelist shape.

## Embedding trap

The script is a non-raw template literal. A flag is inert there. Character-class or escape rewrites are not: `[\s\S]` emits `[sS]`, and `\u2028` emits a raw line terminator that is a syntax error in a regex literal. Tests run the emitted script, which pins the emitted text.

## Known residue (not changed)

A `Date` id (if the YAML loader yields one) stringifies to a quoted ISO string and is tolerated with or without the flag; DSH skips that row too. Not in scope.
