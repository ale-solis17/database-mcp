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

# Containers inherit image labels, so every container started from this image is
# findable even when a client spawned it with an auto-generated name:
#   docker ps -a --filter label=com.database-mcp.stack=database-mcp
LABEL com.database-mcp.stack="database-mcp" \
      com.database-mcp.role="mcp-server" \
      org.opencontainers.image.title="database-mcp" \
      org.opencontainers.image.description="Read-only database MCP server (stdio transport)"

# Only production dependencies in the final image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Where databases.json is expected. It is NOT copied into the image: mount it
# at runtime (-v host/databases.json:/config/databases.json:ro). The file holds
# ${VAR} references rather than values, so the secrets stay in --env-file and
# nothing confidential is ever baked into a layer.
ENV DATABASES_CONFIG=/config/databases.json

# Run as the built-in non-root user.
USER node

# Verify the DEFAULT profile is reachable with its read-only user.
# Deliberately not `--all`: Docker restarts a container it considers unhealthy,
# and a secondary database being asleep must not kill a server whose primary
# database is fine. For the full check, run it by hand:
#   docker exec <name> node dist/healthcheck.js --all
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]

# The MCP server speaks JSON-RPC over stdio. Clients spawn it with `-i`.
CMD ["node", "dist/index.js"]
