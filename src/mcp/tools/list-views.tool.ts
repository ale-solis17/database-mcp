import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, runTool } from "./tool-helpers.js";

export function registerListViewsTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "list_views",
        {
            description: "List views and materialized views, optionally filtered to a schema.",
            inputSchema: {
                schema: z.string().optional().describe("Optional schema name to filter by."),
            },
        },
        async ({ schema }) =>
            runTool("list_views", async () => {
                const views = await ctx.adapter.listViews(schema);
                return jsonResponse(views);
            }),
    );
}
