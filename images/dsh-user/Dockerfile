FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap python3 python3-docx \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.34.6 @deepseek-ai/dsh@0.2.0-rc.2 \
  && npm cache clean --force

RUN useradd -m -u 1001 dsh \
  && mkdir -p /data/home /data/work \
  && chown -R dsh:dsh /data

USER dsh
ENV DSH_HOME=/data/home \
  DSH_TELEMETRY_DISABLED=1
WORKDIR /data/work

# Install pin and expected version are independent literals. Equality is exact,
# so a prefix of the installed version (for example 0.2.0-rc) must fail the build.
RUN installed="$(dsh --version)" \
  && expected="0.2.0-rc.2" \
  && if [ "$installed" != "$expected" ]; then \
       echo "dsh version mismatch: installed=${installed} expected=${expected}" >&2; \
       exit 1; \
     fi

# Initialize the release-owned Web profile without booting Web or copying user state.
RUN dsh --profile web --dump-default-config >/dev/null \
  && mkdir -p "${DSH_HOME}/profiles/web/node_modules/@dsh-team/zh-locale"

# The named context contains only canonical plugin sources, not the repository root.
# Delivery does not activate the plugin; later managed overlays own composition policy.
COPY --from=zh-locale --chown=dsh:dsh --chmod=0644 \
  package.json index.js client.js cordis.patch.yml \
  /data/home/profiles/web/node_modules/@dsh-team/zh-locale/

RUN installed="$(dsh --version)" \
  && peer="$(node -p 'require(process.env.DSH_HOME + "/profiles/web/node_modules/@dsh-team/zh-locale/package.json").peerDependencies["@deepseek-ai/dsh"]')" \
  && if [ "$installed" != "$peer" ]; then \
       echo "zh-locale DSH peer mismatch: installed=${installed} peer=${peer}" >&2; \
       exit 1; \
     fi

USER root
# Security code is never resolved from the employee-writable profile.
COPY --from=permission-tiers --chown=root:root --chmod=0444 \
  package.json index.js review.js client.js \
  /opt/dsh-team/permission-tiers/
RUN installed="$(dsh --version)" \
  && peer="$(node -p 'require("/opt/dsh-team/permission-tiers/package.json").peerDependencies["@deepseek-ai/dsh"]')" \
  && if [ "$installed" != "$peer" ]; then \
       echo "permission-tiers DSH peer mismatch: installed=${installed} peer=${peer}" >&2; \
       exit 1; \
     fi \
  && chmod 0555 /opt/dsh-team /opt/dsh-team/permission-tiers
# Preserve the complete relative tree, including hidden entries, independently of live profiles.
RUN mkdir -p /opt/dsh-team/profile-seed \
  && cp -a "${DSH_HOME}/profiles/." /opt/dsh-team/profile-seed/ \
  && chown -R root:root /opt/dsh-team \
  && chmod -R a-w /opt/dsh-team/profile-seed \
  && chown root:root /opt \
  && chmod go-w /opt /opt/dsh-team

USER dsh
