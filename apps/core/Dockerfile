FROM node:20-slim AS builder

WORKDIR /app

# Install native compilation dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/core/package.json ./apps/core/
COPY apps/dashboard/package.json ./apps/dashboard/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies (including workspace packages)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared ./packages/shared
COPY apps/dashboard ./apps/dashboard
COPY apps/core ./apps/core

# Build shared package first, then dashboard and core
RUN pnpm --filter @reelhub/shared build
RUN pnpm --filter @reelhub/dashboard build
RUN pnpm --filter @reelhub/core build

# ---- Production image ----
FROM node:20-slim

# Install wget (for health check) and ffmpeg (for media probing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r reelhub && useradd -r -g reelhub -d /app -s /sbin/nologin reelhub

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace manifests for production install
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=builder /app/apps/core/package.json ./apps/core/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/apps/core/dist ./apps/core/dist
COPY --from=builder /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Data directory structure (bind-mounted from host at runtime)
RUN mkdir -p /data/db /data/videos/censored /data/videos/raw /data/videos/quarantine \
    /data/temp /data/logs /data/backups /data/browser-profiles

RUN chown -R reelhub:reelhub /app /data

USER reelhub

ENV NODE_ENV=production
ENV STORAGE_ROOT=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/system/health || exit 1

CMD ["node", "apps/core/dist/index.js"]

