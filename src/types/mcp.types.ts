import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectionRegistry } from "../database/connection-registry.js";
import type { QueryLimits } from "./database.types.js";

/**
 * Shared context passed to every MCP tool factory.
 *
 * Tools never talk to a database engine directly — they resolve an adapter for
 * the requested profile out of the registry (see `resolveAdapter` in
 * tool-helpers) and get the safety limits, which are global across profiles.
 */
export interface ToolContext {
    registry: ConnectionRegistry;
    limits: QueryLimits;
}

/** Standard MCP tool response (alias of the SDK's CallToolResult). */
export type McpToolResponse = CallToolResult;
