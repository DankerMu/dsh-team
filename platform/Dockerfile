FROM node:24.13.1-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.34.6 node-gyp@11.5.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY platform/package.json platform/tsconfig.build.json ./platform/
COPY platform/web/package.json ./platform/web/
RUN HUSKY=0 pnpm install --frozen-lockfile
COPY platform/src ./platform/src
COPY platform/web ./platform/web
# Build inside the deployed closure: v13 prefers shipped prebuilds and an implicit
# rebuild can be a no-op. Remove prebuilds so runtime selects this compiled addon.
RUN pnpm build \
  && HUSKY=0 pnpm --filter @dsh-team/platform deploy --prod --legacy /production \
  && cd /production/node_modules/better-sqlite3 \
  && node-gyp clean \
  && node-gyp rebuild --release --force_build=1 \
  && test -s build/Release/better_sqlite3.node \
  && rm -rf prebuilds

FROM node:24.13.1-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /production/package.json ./platform/package.json
COPY --from=build /production/node_modules ./platform/node_modules
COPY --from=build /app/platform/dist ./platform/dist
COPY --from=build /app/platform/web/dist ./platform/web/dist
COPY images/seccomp/dsh-user.json ./images/seccomp/dsh-user.json
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "platform/dist/main.js"]
