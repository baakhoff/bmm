# syntax=docker/dockerfile:1

# The build runs once, on the builder's own architecture. Nothing in the
# production bundle is compiled natively, so its output is the same for every
# target and the final stage only has to copy it.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.23.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm --filter @bmm/server deploy --prod /out

FROM node:24-alpine
ARG VERSION=dev
ENV NODE_ENV=production \
    BMM_VERSION=$VERSION \
    BMM_WEB_DIR=/app/web \
    DATABASE_URL=pglite:///data/pg
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BMM_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
