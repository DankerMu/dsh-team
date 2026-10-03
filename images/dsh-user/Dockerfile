FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap \
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
