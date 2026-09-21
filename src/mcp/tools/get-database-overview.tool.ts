import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, profileParam, resolveAdapter, runTool } from "./tool-helpers.js";

export function registerGetDatabaseOverviewTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "get_database_overview",
        {
            description:
                "Get a compact, high-level overview of the database (schemas with table/view/routine counts, table column lists, and foreign-key relationships) so the model can understand the structure in a single call. Large databases are truncated to stay compact.",
            inputSchema: {
                profile: profileParam(ctx),
            },
        },
        async ({ profile }) =>
            runTool("get_database_overview", async () => {
                const overview = await resolveAdapter(ctx, profile).getDatabaseOverview();
                return jsonResponse(overview);
            }),
    );
}
