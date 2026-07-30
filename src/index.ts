import { fstatSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/server.js";
import { PostgresAdapter } from "./database/postgres/postgres.adapter.js";
import { getDatabaseConfig, getQueryLimits } from "./config/database-config.js";
import { logger } from "./logger.js";
import type { DatabaseAdapter } from "./database/database.adapter.js";

/**
 * Whether stdin can actually carry the MCP protocol.
 *
 * An MCP client spawns us with a pipe on fd 0. A container started WITHOUT `-i`
 * (`docker run` with no `-i`, `docker compose up`, or the Run/Start button in
 * Docker Desktop) gets /dev/null instead: a character device that is not a TTY.
 * Detecting that lets us say so plainly instead of idling as a "healthy"
 * container that no client will ever talk to.
 */
function stdinCanCarryProtocol(): boolean {
    try {
        const stat = fstatSync(0);
        if (stat.isFIFO() || stat.isSocket()) return true;
        // Interactive terminal (`npm start` in a shell, `docker run -it`).
        return process.stdin.isTTY === true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    if (!stdinCanCarryProtocol()) {
        logger.error(
            "stdin is not connected to an MCP client, refusing to start. " +
                "This server speaks JSON-RPC over stdio and must be spawned with stdin attached " +
                "(docker run -i). The Run/Start button in Docker Desktop and `docker compose up` " +
                "do not attach stdin.",
        );
        process.exit(1);
    }

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

    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("Shutting down", { reason });
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

    // The client is our only reason to exist: when it closes the pipe we must
    // exit, otherwise a containerized server lingers forever holding a database
    // connection pool (and reports "healthy" while serving nobody).
    process.stdin.on("end", () => void shutdown("stdin closed"));
    process.stdin.on("close", () => void shutdown("stdin closed"));
}

main().catch((err) => {
    logger.error("Fatal error during startup", {
        error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
});
