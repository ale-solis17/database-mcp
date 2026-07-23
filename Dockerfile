# ─────────────────────────────────────────────────────────────
# Multi-stage build for the read-only Database MCP Server.
# ─────────────────────────────────────────────────────────────

# ---- Build stage: compile TypeScript to dist/ ----
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (including dev) using the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci

# Compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: production-only deps + compiled output ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Only production dependencies in the final image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the built-in non-root user.
USER node

# Verify the database is reachable with the configured read-only user.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]

# The MCP server speaks JSON-RPC over stdio. Clients spawn it with `-i`.
CMD ["node", "dist/index.js"]
