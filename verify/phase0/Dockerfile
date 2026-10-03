FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap git ca-certificates curl procps python3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @deepseek-ai/dsh@0.2.0-rc.2
RUN useradd -m -u 1001 dsh && mkdir -p /data/home /data/work /managed && chown -R dsh:dsh /data
USER dsh
ENV DSH_HOME=/data/home DSH_TELEMETRY_DISABLED=1
WORKDIR /data/work
