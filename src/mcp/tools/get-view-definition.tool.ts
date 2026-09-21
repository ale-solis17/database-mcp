import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { profileParam, resolveAdapter, runTool, textResponse } from "./tool-helpers.js";

export function registerGetViewDefinitionTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "get_view_definition",
        {
            description: "Get the SQL definition of a view or materialized view.",
            inputSchema: {
                schema: z.string().default("public").describe("Schema the view belongs to."),
                view: z.string().describe("View name."),
                profile: profileParam(ctx),
            },
        },
        async ({ schema, view, profile }) =>
            runTool("get_view_definition", async () => {
                const def = await resolveAdapter(ctx, profile).getViewDefinition(schema, view);
                return textResponse(def);
            }),
    );
}
