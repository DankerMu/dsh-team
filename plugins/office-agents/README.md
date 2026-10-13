# Office Agent bundle

This declarative DSH `0.2.0-rc.2` bundle provides `office-general` (综合办公),
the fresh-profile default, and `office-writer` (公文与材料写作). General selects
capabilities, delegates writing and checks results; writer drafts Chinese
notices, requests, explanations and materials. Existing built-in presets remain
available; explicitly selected presets and existing user volumes are preserved.

Both presets declare file operations, shell, native job controls, skill loading
and file delivery. General also declares `subagent` with the native spawn
provider. Neither declares web search/fetch. Runtime schemas—not a second
hand-maintained tool catalog—are the effective tool inventory; managed overlays
and permission gates continue to govern execution.

Both mount the released `office-docx` skill with Office CLI rendering disabled,
using the image's Python/python-docx, plus the bundle's `official-writing`
guidance. Ordinary user/project skill discovery remains available. No document
renderer, RAGFlow integration or additional specialist Agent is introduced.

The image copies `package.json`, `cordis.patch.yml` and
`skills/official-writing/SKILL.md` into
`$DSH_HOME/profiles/web/node_modules/@dsh-team/office-agents/`, registers the
bundle after the released base/Web bundles, and then snapshots the complete
profile tree into `/opt/dsh-team/profile-seed/`. Package directories are created
before file-mode `0644` copies so uid1001 retains traversal. The exact DSH peer
is checked during the build. No package installation or download occurs at
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
  --build-context "office-agents=$(pwd)/plugins/office-agents" images/dsh-user
```

Verification on giap-vps:

```sh
pnpm test:docker platform/test/office-agents.docker.test.ts platform/test/managed-policy.docker.test.ts platform/test/user-image.docker.test.ts
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
the existing platform/model/permission behavior. Actual office-model DOCX and
delegation acceptance belong to tasks17.3–17.5, not this metadata/capability proof.
