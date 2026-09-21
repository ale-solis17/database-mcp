import { loadEnvFile } from "./load-env-file.js";
import { envFilePath } from "./paths.js";

/**
 * Centralized, validated access to environment variables.
 *
 * This module is the only place that reads `process.env` for the server's own
 * settings. The one documented exception is the `${VAR}` interpolator in
 * `databases.ts`, which by design resolves arbitrary user-named variables; it
 * receives the environment by injection so it stays testable.
 *
 * Database connections are NOT here — they live in `databases.json` (see
 * `databases.ts`). This file holds the global settings plus whatever `${VAR}`
 * secrets the profiles reference, which dotenv loads into `process.env` below.
 */

loadEnvFile();

function optional(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * Problems are collected instead of thrown one at a time, so an operator sees
 * every bad value in a single message rather than fixing them one restart at
 * a time. Nothing here is required any more — every setting has a default — so
 * importing this module no longer throws on a bare environment. A missing
 * database configuration is reported by `databases.ts`, with instructions.
 */
const invalid: string[] = [];

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

export const env = {
    mcp: {
        name: optional("MCP_NAME") ?? "database-mcp",
        version: optional("MCP_VERSION") ?? "1.0.0",
    },
    limits: {
        maxRows: toNumber("MAX_ROWS", 1000),
        queryTimeoutMs: toNumber("QUERY_TIMEOUT_MS", 10_000),
        maxResultSizeMb: toNumber("MAX_RESULT_SIZE_MB", 10),
    },
    paths: {
        /** Optional override for the databases.json location. */
        databasesConfig: optional("DATABASES_CONFIG"),
        /** The .env file actually loaded above. */
        envFile: envFilePath(),
    },
} as const;

if (invalid.length > 0) {
    throw new Error(["Invalid configuration:", ...invalid.map((p) => `  ${p}`)].join("\n"));
}

export type Env = typeof env;
