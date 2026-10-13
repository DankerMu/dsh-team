# Office Agent bundle

This declarative DSH `0.2.0-rc.2` bundle registers `office-general` (综合办公)
with one Chinese persona instruction. It adds no tools and does not change the
existing `standard` default. The complete two-Agent office capabilities and
default selection belong to task17.2; this package is their canonical source,
not a separate image-local implementation.

The image copies `package.json` and `cordis.patch.yml` into
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

Verification: `pnpm test:docker platform/test/office-agents.docker.test.ts
platform/test/user-image.docker.test.ts` on giap-vps. The native
`agentPresets/list` response must include the healthy `office-general`/综合办公
entry while preserving the released presets and default. The test starts a
fresh instance through the ordinary platform path; it does not inject a preset
or make a model request. Existing image tests cover complete seed copy-up,
immutability, employee edits across reuse, offline DOCX and real Web startup.
The complete Docker suite also checks managed policy across every shipped preset.
