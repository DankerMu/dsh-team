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
  && mkdir -p "${DSH_HOME}/profiles/web/node_modules/@dsh-team/zh-locale" \
    "${DSH_HOME}/profiles/web/node_modules/@dsh-team/office-agents/skills/official-writing" "${DSH_HOME}/storages"

# Docker copy-up initializes only empty home volumes; this registry remains employee-writable.
# The fixed workspace identity is volume-local and carries no Session or credential state.
COPY --chown=dsh:dsh --chmod=0644 workspace.json /data/home/storages/workspace.json

# The named context contains only canonical plugin sources, not the repository root.
# Delivery does not activate the plugin; later managed overlays own composition policy.
COPY --from=zh-locale --chown=dsh:dsh --chmod=0644 \
  package.json index.js client.js cordis.patch.yml \
  /data/home/profiles/web/node_modules/@dsh-team/zh-locale/

# Bundle registration is an image default, below the employee and managed patch layers.
# Pre-created directories retain traversal bits; COPY's 0644 applies only to the files.
COPY --from=office-agents --chown=dsh:dsh --chmod=0644 \
  package.json docx-construction.js cordis.patch.yml \
  /data/home/profiles/web/node_modules/@dsh-team/office-agents/
COPY --from=office-agents --chown=dsh:dsh --chmod=0644 \
  skills/official-writing/SKILL.md \
  /data/home/profiles/web/node_modules/@dsh-team/office-agents/skills/official-writing/SKILL.md
# DSH skips an incompatible bundle and still exits 0, so its diagnostics fail the build here.
RUN node -e 'const fs = require("node:fs"); \
  const profile = process.env.DSH_HOME + "/profiles/web"; \
  const bundle = require(profile + "/node_modules/@dsh-team/office-agents/package.json"); \
  const path = profile + "/package.json"; \
  const manifest = JSON.parse(fs.readFileSync(path, "utf8")); \
  manifest.dsh.profile.bundles.push(bundle.name); \
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");' \
  && log="$(mktemp)" \
  && if ! dsh --profile web --dump-default-config >/dev/null 2>"$log"; then cat "$log" >&2; exit 1; fi \
  && if grep -E "dsh: (skipping profile bundle|disabling profile plugin)" "$log" >&2; then exit 1; fi \
  && rm -f "$log"

USER root
# Security code is never resolved from the employee-writable profile.
COPY --from=permission-tiers --chown=root:root --chmod=0444 \
  package.json index.js review.js \
  /opt/dsh-team/permission-tiers/
# Platform navigation is delivered read-only beside the security plugin; the overlay enables it.
COPY --from=platform-nav --chown=root:root --chmod=0444 \
  package.json index.js client.js \
  /opt/dsh-team/platform-nav/
# The catalog is the single list of preinstalled items. The gate fails the build when the image
# and the catalog differ in either direction, and checks every delivered plugin's engines.dsh
# (no exact DSH peer) with the released loader's decision: the installed DSH, DSH's own semver
# (declared by dsh-app-boot), prereleases included.
COPY --chmod=0444 catalog.json /opt/dsh-team/catalog.json
# The empty credentials directory is the managed overlay's isolated credential store:
# traversable by uid1001, never writable by it.
RUN node /opt/dsh-team/catalog-check.mjs verify /opt/dsh-team/catalog.json /opt/dsh-team/npm-baseline.json \
  && mkdir /opt/dsh-team/credentials \
  && chmod 0555 /opt/dsh-team /opt/dsh-team/permission-tiers /opt/dsh-team/platform-nav \
    /opt/dsh-team/credentials
# Preserve the complete relative tree, including hidden entries, independently of live profiles.
RUN mkdir -p /opt/dsh-team/profile-seed \
  && cp -a "${DSH_HOME}/profiles/." /opt/dsh-team/profile-seed/ \
  && chown -R root:root /opt/dsh-team \
  && chmod -R a-w /opt/dsh-team/profile-seed \
  && chown root:root /opt \
  && chmod go-w /opt /opt/dsh-team

USER dsh
