FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap python3 python3-docx \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.34.6 @deepseek-ai/dsh@0.2.1-rc.2 \
  && npm cache clean --force

# The baseline is the toolchain (the base image's npm/corepack, pnpm) and DSH: global packages
# the catalog gate below does not count as preinstalled items.
COPY --chmod=0444 catalog-check.mjs /opt/dsh-team/catalog-check.mjs
RUN node /opt/dsh-team/catalog-check.mjs record /opt/dsh-team/npm-baseline.json

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
# The catalog is the single list of preinstalled items, read by registration and the gate below.
COPY --chmod=0444 catalog.json /opt/dsh-team/catalog.json
# COPY --chmod also applies to the directories it creates; restore traversal for uid1001.
RUN chmod 0555 /opt/dsh-team /opt/dsh-team/zh-locale /opt/dsh-team/office-agents \
    /opt/dsh-team/office-agents/skills /opt/dsh-team/office-agents/skills/official-writing \
    /opt/dsh-team/permission-tiers /opt/dsh-team/platform-nav

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
# is not registered as above, and checks every delivered plugin's engines.dsh (no exact DSH peer)
# with the released loader's decision: the installed DSH, DSH's own semver (declared by
# dsh-app-boot), prereleases included.
# The empty credentials directory is the managed overlay's isolated credential store:
# traversable by uid1001, never writable by it.
RUN node /opt/dsh-team/catalog-check.mjs verify /opt/dsh-team/catalog.json /opt/dsh-team/npm-baseline.json \
  && mkdir /opt/dsh-team/credentials \
  && chmod 0555 /opt/dsh-team/credentials
# Preserve the complete relative tree, including hidden entries, independently of live profiles.
RUN mkdir -p /opt/dsh-team/profile-seed \
  && cp -a "${DSH_HOME}/profiles/." /opt/dsh-team/profile-seed/ \
  && chown -R root:root /opt/dsh-team \
  && chmod -R a-w /opt/dsh-team/profile-seed \
  && chown root:root /opt \
  && chmod go-w /opt /opt/dsh-team

USER dsh
