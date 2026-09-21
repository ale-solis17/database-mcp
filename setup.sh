#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Database MCP Server — interactive setup (Linux / macOS).
#
#   ./setup.sh
#
# Checks prerequisites, builds the project, then runs the database wizard
# (scripts/setup-wizard.mjs), which collects one or more databases, verifies
# each connection and its read-only permissions, and writes databases.json
# plus the matching secrets in .env.
#
# The build runs BEFORE the prompts on purpose: the wizard verifies every
# profile as you add it, and that needs dist/ to exist.
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m[!]\033[0m  %s\n' "$1"; }
err()  { printf '  \033[31m[x]\033[0m  %s\n' "$1" >&2; }

bold "Database MCP Server - setup"
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
    warn "Docker is installed but not running (optional)."
  fi
else
  info "Docker not found (optional)."
fi
echo

# ---- Install & build -----------------------------------------------------
# Before the prompts: the wizard checks each database as you enter it, which
# needs dist/. It also means you are not left staring at a long npm install
# right after typing a password.
bold "Installing dependencies and building"
npm install --no-audit --no-fund
npm run build
ok "Build complete."

# ---- .env ----------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env created from .env.example (global settings; not committed to git)."
fi

# ---- Database wizard -----------------------------------------------------
node scripts/setup-wizard.mjs
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
