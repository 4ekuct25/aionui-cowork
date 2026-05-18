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

# curl/ca-certificates/bzip2 are needed to fetch and unpack the Goose
# release tarball, plus bash for the few install scripts we run. The base
# bun image is minimal and ships none of these.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         curl ca-certificates bash bzip2 xz-utils \
         libgomp1 libdbus-1-3 libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# Copy only build artifacts and production deps
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/out/renderer ./out/renderer
COPY package.json bun.lock ./
COPY patches/ ./patches/
RUN bun install --production --ignore-scripts

# Bake the most-used ACP CLIs into the control-plane image so AcpDetector
# finds them on PATH at boot (it scans the control-plane host, not the
# session container). Without these the AgentRegistry only exposes the
# built-in Aion CLI + Gemini worker. Bloat is ~80 MB per package — worth
# it for out-of-the-box parity with the upstream desktop experience.
# Operators on a tight image budget can override with their own
# Dockerfile derivation that drops this step.
#
# IMPORTANT: this image is `oven/bun:latest` — there is no `npm` on PATH,
# so we use `bun install -g`. BUN_INSTALL_BIN=/usr/local/bin in this base
# image so binaries land directly on PATH. The `|| true` swallows
# package-by-package failures so a single broken upstream registry entry
# doesn't take out the whole image build.
RUN bun install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @qwen-code/qwen-code \
      @augmentcode/auggie \
      opencode-ai \
      2>&1 | tail -10 || true

# Goose is a Rust binary distributed via GitHub releases, not npm.
# We bypass the upstream install.sh (it has interactive prompts and
# expects bash/tar/bzip2 in a specific configuration) and fetch the
# tarball directly. The tarball contains a single `goose` executable.
# Failure here is non-fatal — `|| true` keeps the image usable when the
# release URL changes or the network is restricted.
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) GOOSE_TARGET=x86_64-unknown-linux-gnu ;; \
      aarch64|arm64) GOOSE_TARGET=aarch64-unknown-linux-gnu ;; \
      *) echo "[goose] unsupported arch $(uname -m), skipping"; exit 0 ;; \
    esac; \
    curl -fsSL -o /tmp/goose.tar.bz2 \
      "https://github.com/block/goose/releases/download/stable/goose-${GOOSE_TARGET}.tar.bz2" \
    && tar -xjf /tmp/goose.tar.bz2 -C /usr/local/bin/ \
    && rm /tmp/goose.tar.bz2 \
    && chmod +x /usr/local/bin/goose \
    && /usr/local/bin/goose --version \
    || true

# Hermes (Nous Research) is not yet installable via a stable package URL.
# It is lazy-installed on first use by the agent runtime when present;
# AcpDetector will simply not advertise it until the binary appears on PATH.

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
