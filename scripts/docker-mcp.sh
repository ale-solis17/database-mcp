#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Database MCP Server — Docker session helper (Linux / macOS).
#
#   ./scripts/docker-mcp.sh build          # build database-mcp:latest
#   ./scripts/docker-mcp.sh run            # named one-off stdio session
#   ./scripts/docker-mcp.sh run my-name    # explicit container name
#   ./scripts/docker-mcp.sh ps             # list this project's containers
#   ./scripts/docker-mcp.sh clean          # remove stopped ones
#   ./scripts/docker-mcp.sh clean --force  # remove running ones too
#
# Why this exists: `docker run` / `docker compose run` create a brand-new
# container on every invocation and let Docker invent a random name
# ("nervous_panini"), so sessions pile up unidentifiable. Every container this
# script starts gets the name `database-mcp-session-<timestamp>`, is removed on
# exit (--rm), and carries the tracking label used by `ps` and `clean`.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

IMAGE="database-mcp:latest"
LABEL="com.database-mcp.stack=database-mcp"
ENV_FILE="$PROJECT_ROOT/.env"

ok()   { printf '  [OK] %s\n' "$1"; }
warn() { printf '  [!]  %s\n' "$1"; }
err()  { printf '  [x]  %s\n' "$1" >&2; }

command -v docker >/dev/null 2>&1 || { err "Docker is required but was not found."; exit 1; }

ACTION="${1:-run}"

case "$ACTION" in

    build)
        echo "Building $IMAGE"
        docker compose build database-mcp
        ok "Built $IMAGE"
        ;;

    run)
        [ -f "$ENV_FILE" ] || { err ".env not found. Copy .env.example to .env and fill it in first."; exit 1; }
        NAME="${2:-database-mcp-session-$(date +%s)}"
        # Reuse of a name means a previous session was not cleaned up.
        if [ -n "$(docker ps -aq --filter "name=^/${NAME}$")" ]; then
            err "A container named '$NAME' already exists. Remove it or pass another name."
            exit 1
        fi
        echo "Starting MCP stdio session as '$NAME' (Ctrl+C to stop)"
        # -i keeps stdin attached (required by the stdio transport);
        # --rm guarantees the container does not survive the session.
        exec docker run -i --rm --name "$NAME" --env-file "$ENV_FILE" \
            --label "$LABEL" --label "com.database-mcp.role=mcp-server" "$IMAGE"
        ;;

    ps)
        echo "Containers labelled $LABEL"
        docker ps -a --filter "label=$LABEL" \
            --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}'
        ;;

    clean)
        FORCE="${2:-}"
        if [ "$FORCE" = "--force" ]; then
            IDS="$(docker ps -aq --filter "label=$LABEL")"
        else
            IDS="$(docker ps -aq --filter "label=$LABEL" --filter status=exited --filter status=created)"
        fi
        # Only full-length ids pass: `docker rm` treats a short value as an id
        # PREFIX and could match an unrelated container.
        IDS="$(printf '%s\n' "$IDS" | grep -E '^[0-9a-f]{12,64}$' || true)"
        if [ -z "$IDS" ]; then
            ok "Nothing to remove."
            exit 0
        fi
        COUNT="$(printf '%s\n' "$IDS" | wc -l | tr -d ' ')"
        if [ "$FORCE" = "--force" ]; then
            warn "Removing $COUNT container(s), including running sessions."
            # shellcheck disable=SC2086
            docker rm -f $IDS >/dev/null
        else
            # shellcheck disable=SC2086
            docker rm $IDS >/dev/null
        fi
        ok "Removed $COUNT container(s)."
        ;;

    *)
        err "Unknown action '$ACTION'. Use: build | run | ps | clean"
        exit 1
        ;;
esac
