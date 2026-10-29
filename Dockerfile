# Lucid: dashboard, ingest, proxy and Arena in one image.
# Hosted mode turns on by itself (HOST=0.0.0.0): sign-in, per-account projects, keys.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w @lucid/web && npm run build -w @lucid/cli

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4318 \
    LUCID_DATA_DIR=/data
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4318
# 4318 is also the standard OTLP/HTTP port, so exporters work with just the host name.
CMD ["npx", "tsx", "apps/server/src/index.ts"]
