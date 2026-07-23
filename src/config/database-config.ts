import { env } from "./env.js";
import type { DatabaseConfig, DatabaseType, QueryLimits } from "../types/database.types.js";

const SUPPORTED_TYPES: DatabaseType[] = ["postgres", "mysql", "sqlserver"];

/**
 * Builds the typed connection config for the configured engine.
 *
 * This is the seam that makes multi-engine support possible later: the rest of
 * the app asks for a DatabaseConfig, not for specific env vars.
 */
export function getDatabaseConfig(): DatabaseConfig {
    const type = env.database.type;
    if (!SUPPORTED_TYPES.includes(type as DatabaseType)) {
        throw new Error(
            `Unsupported DB_TYPE "${type}". Supported values: ${SUPPORTED_TYPES.join(", ")}`,
        );
    }

    return {
        type: type as DatabaseType,
        host: env.database.host,
        port: env.database.port,
        database: env.database.name,
        user: env.database.user,
        password: env.database.password,
        ssl: env.database.ssl,
    };
}

export function getQueryLimits(): QueryLimits {
    return {
        maxRows: env.limits.maxRows,
        queryTimeoutMs: env.limits.queryTimeoutMs,
        maxResultSizeMb: env.limits.maxResultSizeMb,
    };
}
