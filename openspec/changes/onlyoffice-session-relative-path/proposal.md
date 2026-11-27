## Why

#760: an employee who opens a DOCX, XLSX or PPTX from a file link in the conversation gets 「无法获取编辑器配置: path must be absolute」 instead of the editor. better-sidebar hands every file viewer the path as the employee clicked it, and a conversation link carries a session-relative path. better-sidebar's own file routes resolve such a path under the session working directory (`resolveTarget` in `dsh-better-sidebar@0.28.0` `lib/index.js`). The ONLYOFFICE plugin's `config` and `watch` routes (`dsh-sidebar-onlyoffice@0.2.0` `lib/index.js`, two `path = requireAbsolute(rawPath)` sites) refuse it with 400. The stack lane opens Office files only from the file area, which passes absolute paths, so nothing covered this entry. It blocks acceptance 10 and 11.

## What Changes

- The existing build-time patch of `dsh-sidebar-onlyoffice@0.2.0` (`images/dsh-user/patch-package.mjs`, pin `onlyoffice`) gains replacements for both sites. A relative `path` resolves under the working directory the route has already derived (`sessionCwdOf`); an absolute one stays as it is. The existing `isWithin(cwd, path)` fence then applies unchanged, so a path outside the session directory, `..` escapes included, is still refused with 403.
- `lib/index.js`'s pinned output SHA-256 changes; the input SHA-256, the version check and the rule that a mismatch fails the build stay.
- Tests: the patch-package unit tests pin the new replacements. A Docker test in the real user image drives both routes with relative, escaping and absolute paths. The stack lane opens a DOCX from a conversation file link.

## Impact

- `images/dsh-user/patch-package.mjs` and its test (critical path `images/dsh-user/`: human white-box review of every diff line, stated in the PR).
- `platform/test/onlyoffice-token.docker.test.ts` or a sibling Docker test, and its fixture.
- `platform/test/platform-stack.stack.test.ts` and one Office stack fixture.
- `openspec/specs/office-editing/spec.md` (one added requirement).

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent
Blast radius: Office editing from conversation links; a wrong resolution could expose files outside the session directory
Selected risk packs: File IO / path safety; Release / packaging / dependency compatibility; Legacy compatibility; Public API / script entry; Error handling
Evidence floor: patch-package unit tests; Docker route test in the real image (VPS test:docker); stack lane conversation-link case; VPS test:deploy
```
