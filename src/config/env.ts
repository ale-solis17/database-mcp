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

function required(name: string): string {
    const value = optional(name);
    if (value === undefined) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function toNumber(name: string, fallback: number): number {
    const raw = optional(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Environment variable ${name} must be a positive number, got "${raw}"`);
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

export type Env = typeof env;
