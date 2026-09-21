import { z } from "zod";
import type { McpToolResponse, ToolContext } from "../../types/mcp.types.js";
import type { DatabaseAdapter } from "../../database/database.adapter.js";
import { logger } from "../../logger.js";

/**
 * Resolves the database a tool call targets.
 *
 * An unknown profile throws, and `runTool` turns that into a normal MCP error
 * response listing the valid names — so a wrong guess costs the model one call,
 * not a broken session.
 */
export function resolveAdapter(ctx: ToolContext, profile?: string): DatabaseAdapter {
    return ctx.registry.get(profile);
}

/**
 * The shared `profile` input field, built per server from the configured names.
 *
 * A closed `z.enum` rather than a free string: the SDK serializes it into the
 * tool's JSON Schema, so the model sees the legal values in the schema itself
 * and the value is validated before it reaches our code. The set is fixed for
 * the process lifetime, so there is nothing to invalidate.
 *
 * Deliberately NOT `.default(...)`: leaving it truly optional keeps the
 * argument off the wire, `registry.get(undefined)` already means "the default",
 * and a default would suggest the model must always pass one.
 */
export function profileParam(ctx: ToolContext) {
    // Safe cast: the config loader guarantees at least one profile.
    const names = ctx.registry.profiles.map((p) => p.name) as [string, ...string[]];
    return z
        .enum(names)
        .optional()
        .describe(
            `Which configured database to run against. Omit to use the default (${ctx.registry.defaultProfile}). ` +
                `Available: ${names.join(", ")}. ` +
                "Use list_databases first if you are unsure which one holds the data.",
        );
}

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
