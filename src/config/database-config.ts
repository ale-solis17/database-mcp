import { env } from "./env.js";
import type { QueryLimits } from "../types/database.types.js";

/**
 * Global safety limits, applied to every profile.
 *
 * Connection settings are no longer built here: they come from databases.json
 * via `databases.ts`, one `DatabaseConfig` per named profile.
 */
export function getQueryLimits(): QueryLimits {
    return {
        maxRows: env.limits.maxRows,
        queryTimeoutMs: env.limits.queryTimeoutMs,
        maxResultSizeMb: env.limits.maxResultSizeMb,
    };
}
