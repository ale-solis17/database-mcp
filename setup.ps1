# ─────────────────────────────────────────────────────────────
# Database MCP Server — interactive setup for Windows (PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Checks prerequisites, builds the project, then runs the database wizard
# (scripts/setup-wizard.mjs), which collects one or more databases, verifies
# each connection and its read-only permissions, and writes databases.json
# plus the matching secrets in .env.
#
# The build runs BEFORE the prompts on purpose: the wizard verifies every
# profile as you add it, and that needs dist/ to exist.
#
# The prompting, JSON writing and .env merging live in the Node wizard rather
# than here: PowerShell 5.1 would write a UTF-8 BOM (which breaks both
# JSON.parse and `docker --env-file`), truncate nested JSON at depth 2, and
# emit CRLF into .env. The Node script behaves identically on every platform.
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Write-Ok($m)   { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Write-Warn($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "  [x]  $m"   -ForegroundColor Red }

Write-Host "Database MCP Server - setup" -ForegroundColor Cyan
Write-Host ""

# ---- Prerequisites -------------------------------------------------------
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Ok "Node.js found: $(node --version)"
} else {
    Write-Err "Node.js is required but was not found. Install Node 20+ and re-run."
    exit 1
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
        docker info *> $null
        Write-Ok "Docker is installed and running."
    } catch {
        Write-Warn "Docker is installed but not running (optional)."
    }
} else {
    Write-Host "  Docker not found (optional)."
}
Write-Host ""

# ---- Install & build -----------------------------------------------------
Write-Host "Installing dependencies and building" -ForegroundColor Cyan
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
npm run build
if ($LASTEXITCODE -ne 0) { Write-Err "Build failed. Fix the errors above and re-run."; exit 1 }
Write-Ok "Build complete."

# ---- .env ----------------------------------------------------------------
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Ok ".env created from .env.example (global settings; not committed to git)."
}

# ---- Database wizard -----------------------------------------------------
node scripts/setup-wizard.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# ---- MCP client config ---------------------------------------------------
Write-Host "Connect to an MCP client" -ForegroundColor Cyan
Write-Host "  Generating the config snippet for THIS machine..."
node scripts/generate-mcp-config.mjs
Write-Host ""
$merge = Read-Host "  Merge it into your Claude Desktop config automatically? (y/N)"
if ($merge -eq "y" -or $merge -eq "Y") {
    node scripts/generate-mcp-config.mjs --merge
}
Write-Host ""
Write-Ok "Setup complete. Restart your MCP client to load the server."
