import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseAdapter } from "../database/database.adapter.js";
import type { QueryLimits } from "./database.types.js";

/**
 * Shared context passed to every MCP tool factory.
 *
 * Tools never talk to a database engine directly — they receive an adapter
 * (already resolved to the configured engine) plus the safety limits.
 */
export interface ToolContext {
    adapter: DatabaseAdapter;
    limits: QueryLimits;
}

/** Standard MCP tool response (alias of the SDK's CallToolResult). */
export type McpToolResponse = CallToolResult;
