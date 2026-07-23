import type { McpToolResponse } from "../../types/mcp.types.js";
import { logger } from "../../logger.js";

/** Wraps a value as a standard MCP text response (JSON-serialized). */
export function jsonResponse(value: unknown): McpToolResponse {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
}

/** Wraps plain text as a standard MCP text response. */
export function textResponse(text: string): McpToolResponse {
    return { content: [{ type: "text", text }] };
}

/** Builds a safe error response and logs the failure to stderr. */
export function errorResponse(tool: string, err: unknown): McpToolResponse {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Tool execution failed", { tool, error: message });
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    };
}

/**
 * Runs a tool handler with uniform error handling so a thrown error becomes a
 * safe MCP error response instead of crashing the server.
 */
export async function runTool(
    tool: string,
    handler: () => Promise<McpToolResponse>,
): Promise<McpToolResponse> {
    try {
        return await handler();
    } catch (err) {
        return errorResponse(tool, err);
    }
}
