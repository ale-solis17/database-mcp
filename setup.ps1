# ─────────────────────────────────────────────────────────────
# Database MCP Server — interactive setup for Windows (PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Prompts for PostgreSQL connection details, writes .env, validates the
# connection, checks that the user is read-only, builds the project and prints
# instructions to connect the server to an MCP client (e.g. Claude Code).
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

# ---- Collect connection details -----------------------------------------
Write-Host "PostgreSQL connection" -ForegroundColor Cyan
$DB_HOST = Read-Host "  DB_HOST [localhost]"
if ([string]::IsNullOrWhiteSpace($DB_HOST)) { $DB_HOST = "localhost" }
$DB_PORT = Read-Host "  DB_PORT [5432]"
if ([string]::IsNullOrWhiteSpace($DB_PORT)) { $DB_PORT = "5432" }
$DB_NAME = Read-Host "  DB_NAME"
$DB_USER = Read-Host "  DB_USER (read-only user recommended)"
$DB_PASSWORD_SECURE = Read-Host "  DB_PASSWORD" -AsSecureString
$DB_PASSWORD = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($DB_PASSWORD_SECURE))

$defaultSsl = if ($DB_HOST -eq "localhost" -or $DB_HOST -eq "127.0.0.1") { "false" } else { "true" }
$DB_SSL = Read-Host "  Use SSL? (true/false) [$defaultSsl]"
if ([string]::IsNullOrWhiteSpace($DB_SSL)) { $DB_SSL = $defaultSsl }

if ([string]::IsNullOrWhiteSpace($DB_NAME) -or [string]::IsNullOrWhiteSpace($DB_USER)) {
    Write-Err "DB_NAME and DB_USER are required."
    exit 1
}
Write-Host ""

# ---- Write .env ----------------------------------------------------------
Write-Host "Writing .env" -ForegroundColor Cyan
if (Test-Path .env) {
    Copy-Item .env ".env.backup.$([DateTimeOffset]::Now.ToUnixTimeSeconds())"
    Write-Warn "Existing .env backed up."
}

$envContent = @"
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
"@
Set-Content -Path .env -Value $envContent -Encoding utf8
Write-Ok ".env written (not committed to git)."
Write-Host ""

# ---- Install & build -----------------------------------------------------
Write-Host "Installing dependencies and building" -ForegroundColor Cyan
npm install --no-audit --no-fund
npm run build
Write-Ok "Build complete."
Write-Host ""

# ---- Validate connection -------------------------------------------------
Write-Host "Validating database connection" -ForegroundColor Cyan
npm run --silent healthcheck
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Connection successful."
} else {
    Write-Err "Could not connect. Check your credentials and try again."
    exit 1
}
Write-Host ""

# ---- Verify read-only ----------------------------------------------------
Write-Host "Verifying read-only permissions" -ForegroundColor Cyan
npm run --silent verify-permissions
switch ($LASTEXITCODE) {
    0 { Write-Ok "User appears to be read-only." }
    2 { Write-Warn "User is not strictly read-only. See docs/security.md to create 'mcp_readonly'." }
    default { Write-Warn "Could not verify permissions (continuing)." }
}
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
