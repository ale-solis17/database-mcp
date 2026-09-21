import { fstatSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp/server.js";
import { createRegistry } from "./database/connection-registry.js";
import { ConfigError, getProfilesConfig } from "./config/databases.js";
import { getQueryLimits } from "./config/database-config.js";
import { logger } from "./logger.js";

/**
 * Whether stdin can actually carry the MCP protocol.
 *
 * An MCP client spawns us with a pipe on fd 0. A container started WITHOUT `-i`
 * (`docker run` with no `-i`, `docker compose up`, or the Run/Start button in
 * Docker Desktop) gets /dev/null — or NUL on Windows — instead: a character
 * device that is not a TTY. Detecting that lets us say so plainly instead of
 * idling as a "healthy" container that no client will ever talk to.
 *
 * Deliberately a denylist of the known-bad case rather than an allowlist of
 * pipe-like types: on Windows a piped stdin reports isFIFO(), isSocket(),
 * isFile() and isCharacterDevice() ALL false, so an allowlist rejects every
 * client-spawned server on that platform.
 */
function stdinCanCarryProtocol(): boolean {
    // Interactive terminal (`npm start` in a shell, `docker run -it`).
    if (process.stdin.isTTY) return true;
    try {
        // A character device that is not a TTY is /dev/null or NUL: nobody is
        // ever going to write to it.
        return !fstatSync(0).isCharacterDevice();
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

    const config = getProfilesConfig();
    const registry = createRegistry(config);
    logger.info("Starting database MCP server", {
        configFile: config.sourcePath,
        profiles: config.profiles.map((p) => p.name),
        defaultProfile: config.defaultProfile,
    });

    // Probe the DEFAULT profile only, and only as a warning. The others are
    // opened lazily on first use, and one unreachable database must not stop
    // the model from querying the healthy ones — or from calling list_databases
    // to find out which one is broken.
    try {
        await registry.get().testConnection();
        logger.info("Default profile connection verified", { profile: config.defaultProfile });
    } catch (err) {
        logger.warn("Default profile is not reachable; starting anyway", {
            profile: config.defaultProfile,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    const server = createMcpServer({ registry, limits: getQueryLimits() });
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
            await registry.closeAll();
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
    process.stdin.on("end", () => void shutdown("stdin closed"));
    process.stdin.on("close", () => void shutdown("stdin closed"));
}

main().catch((err) => {
    if (err instanceof ConfigError) {
        // Already a multi-line message written for a human to act on: print it
        // as-is, with no JSON wrapper and no stack. stderr, never stdout —
        // stdout carries the JSON-RPC stream.
        process.stderr.write(`\n${err.message}\n\n`);
    } else {
        logger.error("Fatal error during startup", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    process.exit(1);
});
