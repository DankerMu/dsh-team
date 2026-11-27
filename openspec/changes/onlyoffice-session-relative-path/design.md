## Context

- `dsh-sidebar-onlyoffice@0.2.0` `lib/index.js`, `buildRoutes`:
  - The `config` route derives `cwd = sessionCwdOf(plugin, sessionId, clientCwd)` (the session header's cwd first, then the client's `cwd`, then `process.cwd()`).
  - It then runs `path = requireAbsolute(rawPath)` (400 `path must be absolute` when not absolute), then `isWithin(cwd, path)` (403 when outside).
  - The `watch` route has the same two lines.
  - Every later route takes its path from the minted file-token claims, which hold the resolved absolute path.
- better-sidebar resolves a session-relative target as `resolve(join(cwd, target))`.

## Design

**Change surface:** the `config` and `watch` handlers of the patched `lib/index.js`, through two new entries in `PINS.onlyoffice.replacements`.

- `path = requireAbsolute(rawPath);` occurs in both handlers, so each replacement anchors on text unique to its own route. The nearest is the line before it: `const lang = …` in `config`, the `cwd` line plus the route's own opening in `watch`.
- The replacement value is `path = requireAbsolute(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));`. `isAbsolute` and `join` are already imported by the released module.

**Must preserve:**

- An absolute `path` behaves exactly as released.
- `isWithin` remains the only containment check and still runs after resolution.
- The 400 for a missing `sessionId` or `path`, and the 400 for an unsupported extension, are unchanged.
- The file-secret, document-key, `webStartup` and client refresh replacements are unchanged.
- The package version pin and the input SHA-256 are unchanged.

**Must add:** session-relative `path` support on both routes. An empty `path` stays a 400 (`join(cwd, '')` is the cwd itself, which then fails the extension check).

**Governing invariant:** every path the ONLYOFFICE plugin opens is an absolute path inside the session working directory, whatever form the client sent.

**Sibling surfaces:**

- The released routes are `config`, `file`, `callback` and `watch`, plus the ds proxy, which is keyed by document key.
- `file` and `callback` take their path from the token claims `config` minted, never from the client. They need no change; the PR states this from the released source.
- The client's download fallback sends the same raw `path` and `cwd` to better-sidebar's `/sidebar/file`. That route already resolves session-relative paths (`resolveTarget`), which is why it is untouched.
- `lib/client.js` sends `path` unchanged and is not touched.
- `office-hints` passes props through and is not touched.

**Seams under test:**

- `PINS.onlyoffice`, through the unit tests.
- The two HTTP routes in the real built image, through the Docker test.
- The conversation file link in real DSH, through the stack lane.

**Must preserve (downstream consumers):** the relative form (`path=报告.docx` with session cwd D) and the absolute form (`path=D/报告.docx`) MUST yield the same document key and the same token-claim `path` (`D/报告.docx`). The registry, the callback's overwrite guard, and the forgotten and idle stack lanes all rely on one key per file.

**Required evidence:**

- **Unit tests (behavioural, red first).** In `images/dsh-user/patch-package.test.mjs`, in the style of the existing client.js and canOpen behaviour tests: the released `requireAbsolute` and `isWithin` excerpts, with the patched resolution line, run against cwd `/data/work`.
  - `报告.docx` gives `/data/work/报告.docx`, inside.
  - `../x.docx` gives `/data/x.docx`, outside.
  - `/data/work/a.docx` is unchanged, inside; `/etc/a.docx` is unchanged, outside.
  - Against the released line, the relative case throws. Record that run.
- **Docker tests, real image, both `config` and `watch`, four cases each:**
  - Relative inside (`报告.docx`, cwd D): `config` gives 200 with a registered key. `watch` gives 200 with `text/event-stream; charset=utf-8`, the stream opening with `:ok` as in `platform/test/onlyoffice-token-fixture.ts`.
  - Relative escaping (`../x.docx`): 403 `path outside the session working directory`.
  - Absolute inside: 200, as released.
  - Absolute outside: 403.
  - Plus, on both routes:
    - An empty `path=` gives 400 `unsupported extension ""`.
    - A missing `path` gives 400 `sessionId and path are required`, unchanged.
    - The relative and absolute forms of one file give an equal document key and an equal token-claim `path`.
  - Red: on the pre-change image the relative-inside case answers 400 `path must be absolute`. Record that run.
- **Stack case:**
  - The deterministic provider's scripted assistant reply is exactly a session-relative markdown file link, `[工作通知.docx](工作通知.docx)`, to a DOCX the case wrote into `/data/work`.
  - Clicking the rendered link mounts the editor: the same-origin `/sidebar/onlyoffice/ds/` iframe is visible and 「无法获取编辑器配置」 is absent.
  - The case asserts that the observed `/sidebar/onlyoffice/config` request carried a non-absolute `path`.
  - Console errors are 0, and the file's bytes and sha256 are unchanged.
  - If the released DSH renders such a link without routing it to the file viewer, the implementer finds the conversation entry that sends a relative path and reports it as a deviation, never an absolute-path substitute.

**Non-goals:**

- `~` expansion. A `~/` path fails `isWithin` unless the home is inside cwd, as before.
- Changing better-sidebar.
- Upstreaming. A later version of the package replaces the patch.
- Symlink containment: the lexical `isWithin` fence is kept as released; symlink handling is unchanged and out of scope.

**Review focus:**

- Each replacement matches exactly once and changes only its own route.
- No containment weakening: `..` and absolute-outside cases.
- The new output SHA-256 matches the reviewed text.
- The stack case really goes through a conversation link and not the file area.
