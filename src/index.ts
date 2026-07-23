import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/server.js";
import { PostgresAdapter } from "./database/postgres/postgres.adapter.js";
import { getDatabaseConfig, getQueryLimits } from "./config/database-config.js";
import { logger } from "./logger.js";
import type { DatabaseAdapter } from "./database/database.adapter.js";

async function main(): Promise<void> {
    const dbConfig = getDatabaseConfig();
    logger.info("Starting database MCP server", {
        engine: dbConfig.type,
        host: dbConfig.host,
        database: dbConfig.database,
    });

    // Only PostgreSQL is implemented today; the switch is the extension point.
    let adapter: DatabaseAdapter;
    switch (dbConfig.type) {
        case "postgres":
            adapter = new PostgresAdapter(dbConfig);
            break;
        default:
            throw new Error(`No adapter available for DB_TYPE "${dbConfig.type}"`);
    }

    // Fail fast if the database is unreachable.
    await adapter.testConnection();
    logger.info("Database connection verified");

    const server = createMcpServer({ adapter, limits: getQueryLimits() });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("MCP server connected over stdio");

    const shutdown = async (signal: string): Promise<void> => {
        logger.info("Shutting down", { signal });
        try {
            await server.close();
            await adapter.close();
        } catch (err) {
            logger.error("Error during shutdown", {
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            process.exit(0);
        }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
    logger.error("Fatal error during startup", {
        error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
});
