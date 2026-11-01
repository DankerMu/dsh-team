# Office Agent bundle

This DSH `0.2.1-rc.2` bundle provides `office-general` (综合办公),
the fresh-profile default, and `office-writer` (公文与材料写作). General selects
capabilities, delegates writing and checks results; writer drafts Chinese
notices, requests, explanations and materials. Existing built-in presets remain
available; explicitly selected presets and existing user volumes are preserved.

Both presets declare file operations, shell, native job controls, skill loading
and file delivery. General also declares `subagent` with the native spawn
provider; only writer declares `build_docx`. Neither declares web search/fetch. Runtime schemas—not a second
hand-maintained tool catalog—are the effective tool inventory; managed overlays
and permission gates continue to govern execution.

Both mount the released `office-docx` skill with Office CLI rendering disabled,
using the image's Python/python-docx, plus the bundle's `official-writing`
guidance. Ordinary user/project skill discovery remains available. No document
renderer, RAGFlow integration or additional specialist Agent is introduced.

General's production persona distinguishes substantive writing from ordinary
file operations: notices and materials, including short ones, go through the
native `subagent` tool. The tool takes a short `description` and self-contained
`prompt`; its native `agentPreset`/`allowedAgentPresets` configuration fixes the
child to writer, so `agent_preset` may be omitted and any other value is rejected.
Include the user's facts and output path because the spawn child does not
inherit the parent conversation. General may supply facts or drafts, then
verifies and may edit the real artifact after child construction. Copying an
already completed DOCX is not a substitute for the child's `build_docx` operation.
Unavailable delegation is reported, not replaced with parent-only writing.
The shared `official-writing` skill preserves that boundary.
All existing tools and skill discovery remain available, including ordinary
file work and post-child checks. These instructions do not constitute proof of
model compliance: native child contribution in the unchanged real-model task is
the acceptance gate.

Delegation uses only released DSH behavior; the bundle adds no selection plugin.
General's `tool-subagent` row is configured as `{ provider: spawn, toolName:
subagent, agentPreset: office-writer, allowedAgentPresets: [office-writer] }`.
The released tool requires the default to be one of the allowed presets, shows
the model a single-value `agent_preset` choice, applies writer when the argument
is omitted and rejects every other value before a child exists. The native spawn
provider creates the child with writer from creation: its creation header and
`agentPreset` projection name `office-writer`, and no later
`agent-preset/selected` event rebinds it. Its parent, siblings, model route,
workspace and managed permission tier remain independent.

Delegation is asynchronous. The `subagent` call returns the child's identifier
immediately; when the child settles, the native settlement message carries its
closing text back to the parent. Neither preset declares `tool-subagent-control`
because no `send_message` is needed to obtain the result. General's persona
asks it to verify the real file after that settlement and not to claim
completion before receiving it.

The image copies `package.json`, `docx-construction.js`, `cordis.patch.yml`
and `skills/official-writing/SKILL.md` into the canonical root-owned, mode `0444`
copy `/opt/dsh-team/office-agents/`. `catalog-check.mjs register` then copies it to
`$DSH_HOME/profiles/web/node_modules/@dsh-team/office-agents/` (uid1001, files
`0644`, directories `0755`), records `file:/opt/dsh-team/office-agents` in the
profile `dependencies` and selects the bundle after the released base/Web bundles,
because its catalog image default is enabled; the image then snapshots the complete
profile tree into `/opt/dsh-team/profile-seed/`. DSH loads the bundle from that
employee-writable registration copy, and the plugin page shows its switch. The manifest
declares `engines.dsh` (`>=0.2.1-rc.2 <0.3.0`) and no DSH peer; the build fails
unless the installed DSH satisfies that range under DSH's own `semver` with
prereleases included, and fails if `dsh --profile web --dump-default-config`
reports skipping the bundle. No package installation or download occurs at
instance startup.

The profile's employee patch remains empty; employee and managed layers keep
their existing precedence. Fresh state volumes receive Docker's ordinary
copy-up. Reusing a nonempty volume does not install or overwrite this bundle;
image-upgrade migration is not implemented by this task.

Build from the repository root on the trusted Linux amd64 verification host:

```sh
docker build -f images/dsh-user/Dockerfile -t dsh-team-user \
  --build-context "zh-locale=$(pwd)/plugins/zh-locale" \
  --build-context "permission-tiers=$(pwd)/plugins/permission-tiers" \
  --build-context "office-agents=$(pwd)/plugins/office-agents" \
  --build-context "platform-nav=$(pwd)/plugins/platform-nav" images/dsh-user
```

Verification on giap-vps:

```sh
pnpm test:docker platform/test/office-agents.docker.test.ts platform/test/managed-policy.docker.test.ts platform/test/user-image.docker.test.ts
pnpm test:docker platform/test/office-delegation.docker.test.ts
```

The native selector must expose both healthy Chinese-named presets and only
`office-general` as default. An omitted preset binds a new Session to general;
explicit writer selection binds writer. Both scoped catalogs expose the
associated skills. No test-side preset or model request supplies this evidence.

The existing `managed-policy-observer.js` is the deployed eight-field checker:
it checks native ID/name/role, mounted persona instruction, actual scoped tools,
successfully loaded model-invocable skill bodies, installed package version
(shared by both presets), and native Loader enabled state. Instruction/skill
hashes retain readable-body identity, not proof of model adherence. The oracle
rejects missing required capabilities or metadata and any network tool, both
before and after employee edits/restart. Unrelated tool-less presets remain valid.

Existing image tests cover complete seed copy-up, immutability, employee edits
across reuse, offline DOCX and real Web startup. Full Docker/model checks retain
the existing platform/model/permission behavior. Native delegation checks use
an explicitly deterministic, test-only adapter: actual writer composition,
creation-time writer binding, cold reads/resume, concurrent siblings, exclusions, real
three-tier tool effects, cancellation and missing/broken-target cleanup.
Evidence is retained under `.run/issue213/`; no external model is called by Docker tests.
The real-model acceptance tasks below exercise both presets; deterministic
native protocol checks do not substitute for either acceptance task.

## Preset acceptance tasks

Run from the repository root on trusted giap-vps, with the pinned Node/pnpm,
Linux amd64 Docker and `CHROME_BIN` browser runtime. The real-provider credential
is supplied through `DMXAPI_KEY` in the trusted verification environment, never
through a browser, command argument or committed file.

| Preset                           | Acceptance task                                        | Command           | Required result                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `office-writer` / 公文与材料写作 | 17.3: manually select writer and request a notice      | `pnpm test:model` | The actual requested DOCX opens with python-docx and contains the task's title, recipient, matter, sign-off and date; native evidence binds the selected writer to the completed turn.                                                                                                            |
| `office-general` / 综合办公      | 17.4: submit the same natural-language task to general | `pnpm test:model` | A genuine native writer child performs successful structured `build_docx` construction for the requested target, correlated with its Session/turn/call and pre-parent-resumption artifact; the final DOCX opens and contains all five task fields. Copying an already completed DOCX alone fails. |

Both rows intentionally use the existing combined acceptance command:
`platform/test/managed-model.model.test.ts` runs manual writer and delegated
general scenarios sequentially in the same real-provider lifecycle, alongside
the existing model and permission checks. One successful run covers both rows;
there is no separate per-preset test-name filter or second implementation.
Parent facts/drafts and later parent edits remain allowed; the delegated task
does not certify independent content authorship or rendered page layout.

Missing or empty `DMXAPI_KEY` makes this shared entry exit nonzero with
`DMXAPI_KEY is required for real-model verification` before provisioning.
Neither acceptance task is skipped or reported as passed. To check only this
failure path without invoking a provider:

```sh
env -u DMXAPI_KEY pnpm test:model
```

Real runs retain sanitized native facts, artifact checks and screenshots under
`.run/issue82/model-<runId>/`, including `office-docx.json`,
`office-delegation.json` and `browser-health.json`. Successful acceptance needs
both scenario results, zero browser errors and owned-resource cleanup—not
merely the existence of an evidence directory. Trusted CI additionally requires
the approved source-SHA invocation channel and independent retirement; do not
rerun model acceptance without that authorization.

## Structured DOCX construction

`@dsh-team/office-agents/docx-construction` mounts in the writer preset only,
including manually selected writer Sessions. `build_docx` accepts only
`{path, paragraphs: [{text, style?}]}`; styles are `title`, `heading1`,
`heading2` and `normal` (omitted style means normal). Unknown root/paragraph
properties, completed-document bytes, source-document passthrough and model
code are rejected. There are no notice-specific fields or acceptance shortcuts.

Inputs are bounded to 1–64 paragraphs and 4096 Unicode code points per text.
The UTF-8 encoding of `JSON.stringify(paragraphs.map(p => p.text))` is at most
32768 bytes, including JSON escapes and delimiters. The absolute destination
is at most 4096 UTF-8 bytes; the constructed DOCX is at most 1 MiB.
Relative paths resolve against the calling Session's cwd. Parent directories
must exist. Traversal, outside destinations, symlinks, directories and all
existing destinations fail explicitly; this operation is create-only.
Existing-document editing remains available through ordinary tools and the
released `office-docx` skill. Do not delete user materials to bypass a
create-only rejection.

The dependency-free plugin validates input and performs read-only path
preflight, then calls `ctx.shell.resolve` and `execute` with the actual Session's
resolved sandbox policy, original cancellation signal and a 15-second kill
deadline. Only a fixed `/usr/bin/python3 -I` program executes; user data is JSON
on stdin, never shell interpolation. Python repeats validation, opens each
directory component with no-follow directory descriptors, constructs bytes in
memory, writes a private exclusive file, and atomically links the complete
file into the held destination directory without clobbering an existing target.
Cleanup only addresses the operation's owned temporary file. Abrupt process
termination can leave that private temporary file; a complete published file
can also remain if cancellation occurs after publication. Cancellation is not
rollback, and neither case yields a successful construction receipt.

Success returns exactly `{path, bytes, sha256, uid}` and projects that same
canonical value into native `tool/result` presentation metadata. The hash and
byte count are derived from the constructed buffer inside Python, not from
model claims or a later lookup of an arbitrary destination. Nonzero exits,
timeouts, cancellation, sandbox denial/runner failure, truncated or malformed
receipts and inconsistent receipt fields reject without successful metadata.
`build_docx` uses the unchanged managed mutation authorization/revocation gate.

This proves an observable construction operation, not independent authorship.
Parent facts/drafts and later parent edits are permitted; boundary bytes are
checked against the construction receipt, while final delivery is inspected
separately without requiring final-hash equality. The employee-writable profile
registration copy that DSH loads is not a tamper-proof attestation, and directory descriptors are not a claim
against arbitrary concurrent relocation of workspace directories.

Unit contract tests live in `docx-construction.test.js`; real native scope,
DOCX/style/receipt, create-only/path, permission, sandbox and cancellation
checks remain required alongside the unchanged real-model acceptance gate.
