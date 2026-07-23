import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, runTool } from "./tool-helpers.js";

export function registerGetRelationshipsTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "get_relationships",
        {
            description:
                "List foreign-key relationships between tables (from table/columns -> to table/columns), optionally filtered to a schema.",
            inputSchema: {
                schema: z
                    .string()
                    .optional()
                    .describe("Optional schema to filter the source tables by."),
            },
        },
        async ({ schema }) =>
            runTool("get_relationships", async () => {
                const relations = await ctx.adapter.getRelationships(schema);
                return jsonResponse(relations);
            }),
    );
}
