FROM node:20-slim AS builder
WORKDIR /app

# Install bun
RUN npm install -g bun

# Install all dependencies (including devDeps for build)
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --ignore-scripts

# Copy source
COPY . .

# Build renderer (no Electron needed) and server bundle
RUN bun run build:renderer:web
RUN node scripts/build-server.mjs

# ---- aionrs extractor ----
# Pull the upstream Electron release archive once and pluck out just the
# bundled aionrs binary. Isolating this in its own stage keeps curl + dpkg
# out of the runtime image and lets BuildKit cache the download per arch.
FROM debian:bookworm-slim AS aionrs-extractor
ARG AIONUI_RELEASE=v1.9.25
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates dpkg \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         amd64) DEB_ARCH=amd64; BIN_DIR=linux-x64 ;; \
         arm64) DEB_ARCH=arm64; BIN_DIR=linux-arm64 ;; \
         *) echo "Unsupported TARGETARCH=$TARGETARCH" && exit 1 ;; \
       esac \
    && VERSION="${AIONUI_RELEASE#v}" \
    && curl -fsSL -o /tmp/aionui.deb \
        "https://github.com/iOfficeAI/AionUi/releases/download/${AIONUI_RELEASE}/AionUi-${VERSION}-linux-${DEB_ARCH}.deb" \
    && dpkg-deb -x /tmp/aionui.deb /tmp/extract \
    && cp "/tmp/extract/opt/AionUi/resources/bundled-aionrs/${BIN_DIR}/aionrs" /aionrs \
    && chmod +x /aionrs \
    && rm -rf /tmp/aionui.deb /tmp/extract

# ---- Runtime image ----
FROM oven/bun:latest AS runtime
WORKDIR /app

# Copy only build artifacts and production deps
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/out/renderer ./out/renderer
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --production --ignore-scripts

# aionrs binary lives at the canonical path binaryResolver returns when
# AIONUI_PLATFORM=docker. Same binary is also baked into the
# session-runtime image — Aion CLI currently spawns on the control-plane
# host, ACP/aionrs-in-session-container is Phase 4B work.
COPY --from=aionrs-extractor /aionrs /opt/aionui/aionrs

ENV PORT=3000
ENV NODE_ENV=production
ENV ALLOW_REMOTE=true
ENV DATA_DIR=/data

# SQLite data volume — mount with: -v $(pwd)/data:/data
VOLUME ["/data"]
EXPOSE 3000

CMD ["bun", "dist-server/server.mjs"]
