# ─────────────────────────────────────────────────────────────
# Database MCP Server — Docker session helper (Windows / PowerShell).
#
#   .\scripts\docker-mcp.ps1 build          # build database-mcp:latest
#   .\scripts\docker-mcp.ps1 run            # named one-off stdio session
#   .\scripts\docker-mcp.ps1 run -Name foo  # explicit container name
#   .\scripts\docker-mcp.ps1 ps             # list this project's containers
#   .\scripts\docker-mcp.ps1 clean          # remove stopped ones
#   .\scripts\docker-mcp.ps1 clean -Force   # remove running ones too
#
# Why this exists: `docker run` / `docker compose run` create a brand-new
# container on every invocation and let Docker invent a random name
# ("nervous_panini"), so sessions pile up unidentifiable. Every container this
# script starts gets the name `database-mcp-<label>-<timestamp>`, is removed on
# exit (--rm), and carries the tracking label used by `ps` and `clean`.
# ─────────────────────────────────────────────────────────────
param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "run", "ps", "clean")]
    [string]$Action = "run",

    # Container name to use for `run`. Defaults to database-mcp-session-<unix ts>.
    [string]$Name,

    # `clean` only: also remove running containers.
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -Path $projectRoot

$Image = "database-mcp:latest"
$Label = "com.database-mcp.stack=database-mcp"
$EnvFile = Join-Path $projectRoot ".env"
$ConfigFile = Join-Path $projectRoot "databases.json"

function Write-Ok($m)   { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Write-Warn($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Write-Err($m)  { Write-Host "  [x]  $m"   -ForegroundColor Red }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Err "Docker is required but was not found."
    exit 1
}

function Get-TrackedContainers {
    param([switch]$OnlyStopped)
    $dockerArgs = @("ps", "-a", "--filter", "label=$Label", "--format", "{{.ID}}")
    if ($OnlyStopped) { $dockerArgs += @("--filter", "status=exited", "--filter", "status=created") }
    # Emitted to the pipeline rather than returned: PowerShell unwraps a
    # single-element array on `return`, and callers re-wrap with @(... | where).
    # Only full-length ids pass: a truncated/garbled value would be treated by
    # `docker rm` as an id PREFIX and could match an unrelated container.
    & docker @dockerArgs | Where-Object { $_ -match "^[0-9a-f]{12,64}$" }
}

switch ($Action) {

    "build" {
        Write-Host "Building $Image" -ForegroundColor Cyan
        docker compose build database-mcp
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed."; exit 1 }
        Write-Ok "Built $Image"
    }

    "run" {
        if (-not (Test-Path $EnvFile)) {
            Write-Err ".env not found. Copy .env.example to .env and fill it in first."
            exit 1
        }
        if (-not (Test-Path $ConfigFile)) {
            Write-Err "databases.json not found. Run .\setup.ps1 (or copy databases.example.json)."
            exit 1
        }
        if ([string]::IsNullOrWhiteSpace($Name)) {
            $Name = "database-mcp-session-$([DateTimeOffset]::Now.ToUnixTimeSeconds())"
        }
        # Reuse of a name means a previous session was not cleaned up.
        $existing = & docker ps -aq --filter "name=^/$Name$"
        if (-not [string]::IsNullOrWhiteSpace(($existing -join ""))) {
            Write-Err "A container named '$Name' already exists. Remove it or pass -Name."
            exit 1
        }
        Write-Host "Starting MCP stdio session as '$Name' (Ctrl+C to stop)" -ForegroundColor Cyan
        # -i keeps stdin attached (required by the stdio transport);
        # --rm guarantees the container does not survive the session.
        # databases.json is mounted read-only rather than baked into the image:
        # it holds ${VAR} references, and the values come from --env-file.
        docker run -i --rm --name $Name `
            --env-file $EnvFile `
            -v "$($ConfigFile):/config/databases.json:ro" `
            -e DATABASES_CONFIG=/config/databases.json `
            --label $Label --label "com.database-mcp.role=mcp-server" $Image
        exit $LASTEXITCODE
    }

    "ps" {
        Write-Host "Containers labelled $Label" -ForegroundColor Cyan
        docker ps -a --filter "label=$Label" `
            --format "table {{.Names}}`t{{.Image}}`t{{.Status}}`t{{.CreatedAt}}"
    }

    "clean" {
        $ids = @(Get-TrackedContainers -OnlyStopped:(-not $Force) | Where-Object { $_ })
        if ($ids.Count -eq 0) {
            Write-Ok "Nothing to remove."
            break
        }
        $rmArgs = @("rm")
        if ($Force) {
            Write-Warn "Removing $($ids.Count) container(s), including running sessions."
            $rmArgs += "-f"
        }
        foreach ($id in $ids) {
            # Belt and braces: never hand `docker rm` anything but a full id.
            if ($id -notmatch "^[0-9a-f]{12,64}$") {
                Write-Err "Refusing to remove suspicious container id '$id'."
                exit 1
            }
            $rmArgs += $id
        }
        & docker @rmArgs | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Err "docker rm failed."; exit 1 }
        Write-Ok "Removed $($ids.Count) container(s)."
    }
}
