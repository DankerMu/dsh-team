FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# DSH's document preview converts DOC/PPT/DOCX in the instance with its bundled WASM LibreOffice,
# which imports only installed fonts and refuses to convert without any (#554); no system
# LibreOffice is installed. The Debian free fonts cover Chinese and Latin text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap python3 python3-docx fonts-noto-cjk fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
# Paths as installed by the bookworm packages (dpkg -L): fonts-noto-cjk 1:20220127+repack1-1 and
# fonts-dejavu-core 2.37-6.
RUN for font in /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
      /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf; do \
       if [ ! -f "$font" ]; then echo "preview fonts missing: $font" >&2; exit 1; fi; \
     done

RUN npm install -g pnpm@10.34.6 @deepseek-ai/dsh@0.2.1-rc.2 \
  && npm cache clean --force

# The baseline is the toolchain (the base image's npm/corepack, pnpm) and DSH: global packages
# the catalog gate below does not count as preinstalled items.
COPY --chmod=0444 catalog-check.mjs /opt/dsh-team/catalog-check.mjs
RUN node /opt/dsh-team/catalog-check.mjs record /opt/dsh-team/npm-baseline.json

# The third-party sidebar's code is the unpatched npm release; its manifest only gains
# bundleDependencies (below). It is delivered like the repository plugins: a real root-owned
# directory with its dependency closure nested below it, never a global package.
# --legacy-peer-deps keeps a second DSH and React out of that closure, --no-bin-links leaves no
# symlink for registration to refuse, and --before pins every dependency to one resolution moment
# (after the 0.28.0 release, older than the repository's 7-day minimum release age).
RUN prefix="$(mktemp -d)" \
  && npm install -g --prefix "$prefix" --legacy-peer-deps --ignore-scripts --no-bin-links \
       --no-audit --no-fund --before=2026-10-31T00:00:00Z dsh-better-sidebar@0.28.0 \
  && mv "$prefix/lib/node_modules/dsh-better-sidebar" /opt/dsh-team/dsh-better-sidebar \
  && rm -rf "$prefix" \
  && npm cache clean --force \
  && chown -R root:root /opt/dsh-team/dsh-better-sidebar \
  && find /opt/dsh-team/dsh-better-sidebar -type d -exec chmod 0555 {} + \
  && find /opt/dsh-team/dsh-better-sidebar -type f -exec chmod 0444 {} +
# Install pin and expected version are independent literals, like the DSH check below; equality
# is exact, so a prefix of the installed version (for example 0.28) must fail the build.
RUN installed="$(node -p 'require("/opt/dsh-team/dsh-better-sidebar/package.json").version')" \
  && expected="0.28.0" \
  && if [ "$installed" != "$expected" ]; then \
       echo "dsh-better-sidebar version mismatch: installed=${installed} expected=${expected}" >&2; \
       exit 1; \
     fi

# The ONLYOFFICE editor plugin is delivered the same way (its 0.2.0 release predates --before).
RUN prefix="$(mktemp -d)" \
  && npm install -g --prefix "$prefix" --legacy-peer-deps --ignore-scripts --no-bin-links \
       --no-audit --no-fund --before=2026-10-31T00:00:00Z dsh-sidebar-onlyoffice@0.2.0 \
  && mv "$prefix/lib/node_modules/dsh-sidebar-onlyoffice" /opt/dsh-team/dsh-sidebar-onlyoffice \
  && rm -rf "$prefix" \
  && npm cache clean --force \
  && chown -R root:root /opt/dsh-team/dsh-sidebar-onlyoffice \
  && find /opt/dsh-team/dsh-sidebar-onlyoffice -type d -exec chmod 0555 {} + \
  && find /opt/dsh-team/dsh-sidebar-onlyoffice -type f -exec chmod 0444 {} +
RUN installed="$(node -p 'require("/opt/dsh-team/dsh-sidebar-onlyoffice/package.json").version')" \
  && expected="0.2.0" \
  && if [ "$installed" != "$expected" ]; then \
       echo "dsh-sidebar-onlyoffice version mismatch: installed=${installed} expected=${expected}" >&2; \
       exit 1; \
     fi
# Before registration and the profile seed, so every later copy is the patched file: the file
# token secret and document key derive from the per-instance DSH_TEAM_ONLYOFFICE_FILE_SECRET.
# Any version, copy or hash drift fails the build; the bind mount keeps the script out of layers.
RUN --mount=type=bind,source=patch-package.mjs,target=/tmp/patch-package.mjs \
  node /tmp/patch-package.mjs onlyoffice /opt/dsh-team "$(npm root -g)"

# Each named context contains only canonical plugin sources, not the repository root.
# /opt/dsh-team/<id> is every plugin's canonical copy, outside the employee-writable home.
# Delivery does not activate a plugin; the managed overlay owns composition policy.
COPY --from=zh-locale --chown=root:root --chmod=0444 \
  package.json index.js client.js cordis.patch.yml \
  /opt/dsh-team/zh-locale/
COPY --from=office-agents --chown=root:root --chmod=0444 \
  package.json docx-construction.js cordis.patch.yml \
  /opt/dsh-team/office-agents/
COPY --from=office-agents --chown=root:root --chmod=0444 \
  skills/official-writing/SKILL.md \
  /opt/dsh-team/office-agents/skills/official-writing/SKILL.md
# Security code is never resolved from the employee-writable profile.
COPY --from=permission-tiers --chown=root:root --chmod=0444 \
  package.json index.js review.js cordis.patch.yml \
  /opt/dsh-team/permission-tiers/
# Platform navigation is delivered read-only beside the security plugin; the overlay enables it.
COPY --from=platform-nav --chown=root:root --chmod=0444 \
  package.json index.js client.js cordis.patch.yml \
  /opt/dsh-team/platform-nav/
# The knowledge-base bundle's patch inserts its host half from this canonical copy by absolute path.
COPY --from=knowledge-base --chown=root:root --chmod=0444 \
  package.json index.js client.js cordis.patch.yml \
  /opt/dsh-team/knowledge-base/
# The catalog is the single list of preinstalled items, read by registration and the gate below.
COPY --chmod=0444 catalog.json /opt/dsh-team/catalog.json
# COPY --chmod also applies to the directories it creates; restore traversal for uid1001.
RUN chmod 0555 /opt/dsh-team /opt/dsh-team/zh-locale /opt/dsh-team/office-agents \
    /opt/dsh-team/office-agents/skills /opt/dsh-team/office-agents/skills/official-writing \
    /opt/dsh-team/permission-tiers /opt/dsh-team/platform-nav /opt/dsh-team/knowledge-base
# Every entry with dependencies declares them as bundleDependencies, so the employee's pnpm takes
# the nested closure from the package instead of resolving it from a registry; a missing nested
# dependency or an existing bundle field fails the build. It runs as root after the patch and the
# catalog, before registration and the profile seed copy these manifests.
RUN node /opt/dsh-team/catalog-check.mjs bundle /opt/dsh-team/catalog.json

RUN useradd -m -u 1001 dsh \
  && mkdir -p /data/home /data/work \
  && chown -R dsh:dsh /data

USER dsh
ENV DSH_HOME=/data/home \
  DSH_TELEMETRY_DISABLED=1
WORKDIR /data/work

# Install pin and expected version are independent literals. Equality is exact,
# so a prefix of the installed version (for example 0.2.1-rc) must fail the build.
RUN installed="$(dsh --version)" \
  && expected="0.2.1-rc.2" \
  && if [ "$installed" != "$expected" ]; then \
       echo "dsh version mismatch: installed=${installed} expected=${expected}" >&2; \
       exit 1; \
     fi

# Initialize the release-owned Web profile without booting Web or copying user state.
RUN dsh --profile web --dump-default-config >/dev/null \
  && mkdir -p "${DSH_HOME}/storages"

# Docker copy-up initializes only empty home volumes; this registry remains employee-writable.
# The fixed workspace identity is volume-local and carries no Session or credential state.
COPY --chown=dsh:dsh --chmod=0644 workspace.json /data/home/storages/workspace.json

# Every catalog entry becomes an installed profile dependency (file:/opt/dsh-team/<id>) with a
# uid1001 copy, so the DSH plugin page lists it; image-default-enabled bundles are also selected,
# below the employee and managed patch layers.
RUN node /opt/dsh-team/catalog-check.mjs register /opt/dsh-team/catalog.json
# DSH skips an incompatible bundle and still exits 0, so its diagnostics fail the build here.
RUN log="$(mktemp)" \
  && if ! dsh --profile web --dump-default-config >/dev/null 2>"$log"; then cat "$log" >&2; exit 1; fi \
  && if grep -E "dsh: (skipping profile bundle|disabling profile plugin)" "$log" >&2; then exit 1; fi \
  && rm -f "$log"

USER root
# The gate fails the build when the image and the catalog differ in either direction or an entry
# is not registered as above, and checks every delivered plugin against the installed DSH: a
# repository plugin's engines.dsh (no exact DSH peer) with DSH's own semver (declared by
# dsh-app-boot), prereleases included; any other package with dsh-app-boot's own loader decision.
# The empty credentials directory is the managed overlay's isolated credential store:
# traversable by uid1001, never writable by it.
RUN node /opt/dsh-team/catalog-check.mjs verify /opt/dsh-team/catalog.json /opt/dsh-team/npm-baseline.json \
  && mkdir /opt/dsh-team/credentials \
  && chmod 0555 /opt/dsh-team/credentials
# Preserve the complete relative tree, including hidden entries, independently of live profiles.
# cp -a keeps uid1001 ownership; the seed is the only such tree, as everything else under
# /opt/dsh-team was written root-owned above, and re-chowning it would copy it into this layer.
RUN mkdir -p /opt/dsh-team/profile-seed \
  && cp -a "${DSH_HOME}/profiles/." /opt/dsh-team/profile-seed/ \
  && chown -R root:root /opt/dsh-team/profile-seed \
  && chmod -R a-w /opt/dsh-team/profile-seed \
  && chown root:root /opt \
  && chmod go-w /opt /opt/dsh-team

USER dsh
