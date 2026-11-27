# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# isolated-vm is a C++ addon wrapping V8's Isolate API.
# node-gyp compiles it during npm install — requires these build tools.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/        ./src/

RUN npm run build && npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime

LABEL org.opencontainers.image.title="Harbor" \
      org.opencontainers.image.description="MCP gateway that connects AI agents to backend APIs" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.authors="Vijaydeep Sinha" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/vijaydeepsinha/harbor"

WORKDIR /app

RUN addgroup -S harbor && adduser -S harbor -G harbor

COPY --from=builder --chown=harbor:harbor /app/dist         ./dist
COPY --from=builder --chown=harbor:harbor /app/node_modules ./node_modules
COPY --from=builder --chown=harbor:harbor /app/package.json ./

# Apache 2.0 requires LICENSE and NOTICE in all distributions
COPY --chown=harbor:harbor LICENSE NOTICE ./

# Gateway-owned Governance Rule directory; service policies remain with services.
COPY --chown=harbor:harbor governance/rules/ ./governance/rules/

# Demo services bundled — image works out of the box.
# Mount your own services at runtime:
#   docker run -v ./my-services:/app/services harbor-gateway
COPY --chown=harbor:harbor services/ ./services/

USER harbor

# dist/index.js defaults to ../services (/app/services); SERVICES_DIR pins it
# explicitly so a mounted directory elsewhere only needs this variable changed.
# MCP_HOST must be 0.0.0.0 — 127.0.0.1 is unreachable from outside the container.
ENV MCP_HOST=0.0.0.0 \
    MCP_PORT=3333 \
    NODE_ENV=production \
    SERVICES_DIR=/app/services

EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3333/health || exit 1

CMD ["node", "dist/index.js"]
