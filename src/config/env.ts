import "dotenv/config";

/**
 * Centralized, validated access to environment variables.
 *
 * This module is the ONLY place that reads process.env, so the rest of the
 * codebase depends on typed values instead of scattered env lookups.
 */

function optional(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * Problems are collected instead of thrown one at a time, so an operator with an
 * empty environment sees every missing variable in a single message rather than
 * fixing them one container restart at a time.
 */
const missing: string[] = [];
const invalid: string[] = [];

function required(name: string): string {
    const value = optional(name);
    if (value === undefined) {
        missing.push(name);
        return "";
    }
    return value;
}

function toNumber(name: string, fallback: number): number {
    const raw = optional(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        invalid.push(`${name} must be a positive number, got "${raw}"`);
        return fallback;
    }
    return parsed;
}

function toBoolean(name: string, fallback: boolean): boolean {
    const raw = optional(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    return raw === "true" || raw === "1" || raw === "yes";
}

export const env = {
    database: {
        type: (optional("DB_TYPE") ?? "postgres").toLowerCase(),
        host: required("DB_HOST"),
        port: toNumber("DB_PORT", 5432),
        name: required("DB_NAME"),
        user: required("DB_USER"),
        password: required("DB_PASSWORD"),
        // SSL defaults to true for non-local hosts (managed providers usually need it).
        ssl: toBoolean("DB_SSL", !["localhost", "127.0.0.1"].includes(optional("DB_HOST") ?? "")),
    },
    mcp: {
        name: optional("MCP_NAME") ?? "database-mcp",
        version: optional("MCP_VERSION") ?? "1.0.0",
    },
    limits: {
        maxRows: toNumber("MAX_ROWS", 1000),
        queryTimeoutMs: toNumber("QUERY_TIMEOUT_MS", 10_000),
        maxResultSizeMb: toNumber("MAX_RESULT_SIZE_MB", 10),
    },
} as const;

if (missing.length > 0 || invalid.length > 0) {
    // Nothing is baked into the Docker image on purpose (credentials must never
    // ship inside an image), so a container started without an env file lands
    // here. Spell out how to pass the configuration for each launch method.
    const lines = ["Invalid configuration:"];
    if (missing.length > 0) {
        lines.push(`  Missing required environment variable(s): ${missing.join(", ")}`);
    }
    for (const problem of invalid) {
        lines.push(`  ${problem}`);
    }
    lines.push(
        "",
        "Configuration is read from the environment; the Docker image contains no credentials.",
        "  Local Node : copy .env.example to .env and fill it in",
        "  Docker     : docker run -i --rm --env-file .env database-mcp:latest",
        "  Compose    : docker compose run --rm database-mcp   (reads .env via env_file)",
        "  Helper     : ./scripts/docker-mcp.sh run   |   .\\scripts\\docker-mcp.ps1 run",
        "",
        'Note: the "Run"/"Start" button in Docker Desktop does NOT pass .env, which is the',
        "usual cause of this error. Use one of the commands above instead.",
    );
    throw new Error(lines.join("\n"));
}

export type Env = typeof env;
