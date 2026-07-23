import { PostgresAdapter } from "./database/postgres/postgres.adapter.js";
import { getDatabaseConfig } from "./config/database-config.js";

/**
 * Standalone health check used by Docker HEALTHCHECK.
 *
 * Verifies the database is reachable with the configured (read-only) user and
 * exits 0 on success, 1 on failure. Writes nothing to stdout to stay safe.
 */
async function run(): Promise<void> {
    const adapter = new PostgresAdapter(getDatabaseConfig());
    try {
        await adapter.testConnection();
        process.exit(0);
    } catch (err) {
        process.stderr.write(
            `healthcheck failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    } finally {
        await adapter.close().catch(() => undefined);
    }
}

void run();
