# syntax=docker/dockerfile:1

# The build runs once, on the builder's own architecture. Nothing in the
# production bundle is compiled natively, so its output is the same for every
# target and the final stage only has to copy it.
FROM --platform=$BUILDPLATFORM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /repo
# renovate: datasource=npm depName=pnpm
ARG PNPM_VERSION=12.23.0
RUN npm install -g pnpm@${PNPM_VERSION}
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm --filter @bmm/server deploy --prod /out

FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
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
LABEL org.opencontainers.image.title="BMM" \
      org.opencontainers.image.description="Better Marketing Management: self-hosted social media management" \
      org.opencontainers.image.source="https://github.com/baakhoff/bmm" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
# npm and its dependency tree are not used at runtime; removing them takes
# their CVEs out of the image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn* \
    && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BMM_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
