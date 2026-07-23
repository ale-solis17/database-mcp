import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "../config/env.js";
import { registerTools } from "./tools/index.js";
import type { ToolContext } from "../types/mcp.types.js";

/**
 * Builds the MCP server and registers all tools.
 *
 * The server is decoupled from any database engine: it receives a ToolContext
 * (already-resolved adapter + limits) and wires tools against it.
 */
export function createMcpServer(context: ToolContext): McpServer {
    const server = new McpServer({
        name: env.mcp.name,
        version: env.mcp.version,
    });

    registerTools(server, context);

    return server;
}
