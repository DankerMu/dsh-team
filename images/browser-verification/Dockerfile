FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2

# Mirror only ordinary Debian packages; retain the official security source and archive signatures.
# CfT 140.0.7339.82 chrome-headless-shell's deb.deps; alternatives selected for bookworm.
RUN --mount=type=bind,from=build-tools,target=/build-tools,ro \
    node /build-tools/debian-sources.mjs /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation fonts-noto-cjk libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libatspi2.0-0 libc6 libcairo2 libcups2 libcurl4 libdbus-1-3 libexpat1 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libudev1 \
    libvulkan1 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=browser-runtime /probe-browser-runtime.mjs /opt/dsh-team/probe-browser-runtime.mjs
COPY --from=browser-runtime /byte-listener.mjs /opt/dsh-team/byte-listener.mjs
COPY --from=browser-runtime /probe-browser-native.mjs /opt/dsh-team/probe-browser-native.mjs
COPY --from=browser-runtime /probe-browser-receipt.mjs /opt/dsh-team/probe-browser-receipt.mjs
COPY --from=browser-runtime /probe-browser-network.mjs /opt/dsh-team/probe-browser-network.mjs
COPY --from=browser-runtime /docker-proxy-environment.mjs /opt/dsh-team/docker-proxy-environment.mjs
USER 1000:1000
ENTRYPOINT ["node", "/opt/dsh-team/probe-browser-runtime.mjs"]
