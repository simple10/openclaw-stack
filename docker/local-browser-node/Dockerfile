# Local browser node with KasmVNC + Chromium.
# Stage 1 builds OpenClaw from source, Stage 2 runs it on kasmweb/chromium
# with Chromium visible at https://localhost:6901.

# ── Stage 1: Build OpenClaw ──────────────────────────────────────
FROM node:22-bookworm AS builder

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable

ARG OPENCLAW_VERSION=stable
WORKDIR /tmp/openclaw-src
RUN git clone --depth=50 https://github.com/openclaw/openclaw.git . && \
    git fetch --tags --force && \
    if [ "$OPENCLAW_VERSION" = "stable" ]; then \
      TAG=$(git tag -l 'v20*' | grep -vE '(beta|rc|alpha)' | sort -V | tail -1) && \
      echo "[build] Latest stable tag: ${TAG}" && \
      git checkout "$TAG"; \
    elif [ "$OPENCLAW_VERSION" = "latest" ]; then \
      echo "[build] Using main branch"; \
    else \
      echo "[build] Checking out ${OPENCLAW_VERSION}" && \
      git checkout "$OPENCLAW_VERSION"; \
    fi

WORKDIR /app
RUN cp /tmp/openclaw-src/package.json /tmp/openclaw-src/pnpm-lock.yaml \
       /tmp/openclaw-src/pnpm-workspace.yaml /tmp/openclaw-src/.npmrc ./ && \
    mkdir -p ui && cp /tmp/openclaw-src/ui/package.json ./ui/ && \
    cp -r /tmp/openclaw-src/patches ./patches && \
    cp -r /tmp/openclaw-src/scripts ./scripts

RUN NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile

RUN cp -r /tmp/openclaw-src/. /app/ && rm -rf /tmp/openclaw-src
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

# ── Stage 2: Kasm Chromium with OpenClaw ─────────────────────────
FROM kasmweb/chromium:1.16.1

USER root

# Node.js 22 (runtime only — build happened in stage 1)
# kasmweb/chromium already includes Chromium
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy built OpenClaw from builder
COPY --from=builder /app /app
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw && chmod 755 /app/openclaw.mjs

# Copy local scripts
COPY ws-proxy.mjs /app/ws-proxy.mjs
COPY kasm-openclaw.sh /usr/local/bin/kasm-openclaw.sh
RUN chmod +x /usr/local/bin/kasm-openclaw.sh

# Launch OpenClaw node host alongside Kasm's Chromium startup.
# Insert after the shebang so it runs before Kasm's blocking Chromium loop.
RUN sed -i '2i\# Start OpenClaw node host in background\n/usr/local/bin/kasm-openclaw.sh &\nsleep 1' /dockerstartup/custom_startup.sh

# OpenClaw data dir for kasm-user (uid 1000)
RUN mkdir -p /home/kasm-default-profile/.openclaw && \
    chown 1000:1000 /home/kasm-default-profile/.openclaw

ENV HOME=/home/kasm-user
ENV NODE_ENV=production
ENV OPENCLAW_PREFER_PNPM=1

USER 1000
