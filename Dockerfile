# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY packages ./packages
COPY apps ./apps
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
# ffmpeg converts the packs and recordings; bsdtar (libarchive) unpacks zip, 7z and rar archives.
RUN apk add --no-cache ffmpeg libarchive-tools tini
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_ROOT=/app/web \
    TRUST_PROXY=true \
    ARCHIVE_TOOL=bsdtar
WORKDIR /app
RUN printf '{"type":"module"}\n' > package.json && mkdir -p /data && chown node:node /data
COPY --from=deps /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/server/dist ./server
COPY --from=build /workspace/apps/web/dist ./web
USER node
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/main.js"]
