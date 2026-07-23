#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Database MCP Server — interactive setup for Linux/macOS.
#
#   ./setup.sh
#
# Prompts for PostgreSQL connection details, writes .env, validates the
# connection, checks that the user is read-only, builds the project and prints
# instructions to connect the server to an MCP client (e.g. Claude Code).
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✔ %s\033[0m\n' "$1"; }
err()  { printf '\033[31m  x %s\033[0m\n' "$1" >&2; }

bold "Database MCP Server — setup"
echo

# ---- Prerequisites -------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  ok "Node.js found: $(node --version)"
else
  err "Node.js is required but was not found. Install Node 20+ and re-run."
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "Docker is installed and running."
  else
    warn "Docker is installed but not running (optional; only needed for the Docker workflow)."
  fi
else
  info "Docker not found (optional)."
fi
echo

# ---- Collect connection details -----------------------------------------
bold "PostgreSQL connection"
read -r -p "  DB_HOST [localhost]: " DB_HOST; DB_HOST="${DB_HOST:-localhost}"
read -r -p "  DB_PORT [5432]: " DB_PORT; DB_PORT="${DB_PORT:-5432}"
read -r -p "  DB_NAME: " DB_NAME
read -r -p "  DB_USER (read-only user recommended): " DB_USER
read -r -s -p "  DB_PASSWORD: " DB_PASSWORD; echo

default_ssl="false"
case "$DB_HOST" in
  localhost|127.0.0.1) default_ssl="false" ;;
  *) default_ssl="true" ;;
esac
read -r -p "  Use SSL? (true/false) [$default_ssl]: " DB_SSL; DB_SSL="${DB_SSL:-$default_ssl}"

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
  err "DB_NAME and DB_USER are required."
  exit 1
fi
echo

# ---- Write .env ----------------------------------------------------------
bold "Writing .env"
if [ -f .env ]; then
  cp .env ".env.backup.$(date +%s)"
  warn "Existing .env backed up."
fi

cat > .env <<EOF
### DATABASE CONFIGURATION ###
DB_TYPE=postgres
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_SSL=$DB_SSL

### MCP SERVER ###
MCP_NAME=database-mcp
MCP_VERSION=1.0.0

### SAFETY LIMITS ###
MAX_ROWS=1000
QUERY_TIMEOUT_MS=10000
MAX_RESULT_SIZE_MB=10
EOF
ok ".env written (not committed to git)."
echo

# ---- Install & build -----------------------------------------------------
bold "Installing dependencies and building"
npm install --no-audit --no-fund
npm run build
ok "Build complete."
echo

# ---- Validate connection -------------------------------------------------
bold "Validating database connection"
if npm run --silent healthcheck; then
  ok "Connection successful."
else
  err "Could not connect. Check your credentials and try again."
  exit 1
fi
echo

# ---- Verify read-only ----------------------------------------------------
bold "Verifying read-only permissions"
set +e
npm run --silent verify-permissions
PERM_STATUS=$?
set -e
if [ "$PERM_STATUS" -eq 0 ]; then
  ok "User appears to be read-only."
elif [ "$PERM_STATUS" -eq 2 ]; then
  warn "User is not strictly read-only. See docs/security.md to create 'mcp_readonly'."
else
  warn "Could not verify permissions (continuing)."
fi
echo

# ---- MCP client config ---------------------------------------------------
bold "Connect to an MCP client"
info "Generating the config snippet for THIS machine..."
node scripts/generate-mcp-config.mjs
echo
read -r -p "  Merge it into your Claude Desktop config automatically? (y/N): " MERGE
if [ "${MERGE:-N}" = "y" ] || [ "${MERGE:-N}" = "Y" ]; then
  node scripts/generate-mcp-config.mjs --merge
fi
echo
ok "Setup complete. Restart your MCP client to load the server."
