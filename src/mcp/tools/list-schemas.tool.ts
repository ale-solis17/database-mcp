import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, profileParam, resolveAdapter, runTool } from "./tool-helpers.js";

export function registerListSchemasTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "list_schemas",
        {
            description:
                "List all user-visible schemas in the database (internal system schemas are excluded).",
            inputSchema: {
                profile: profileParam(ctx),
            },
        },
        async ({ profile }) =>
            runTool("list_schemas", async () => {
                const schemas = await resolveAdapter(ctx, profile).listSchemas();
                return jsonResponse(schemas);
            }),
    );
}
