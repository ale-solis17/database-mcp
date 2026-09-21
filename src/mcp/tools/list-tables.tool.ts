import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, profileParam, resolveAdapter, runTool } from "./tool-helpers.js";

export function registerListTablesTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "list_tables",
        {
            description:
                "List tables in the database, optionally filtered to a single schema. Returns schema, table name and comment.",
            inputSchema: {
                schema: z
                    .string()
                    .optional()
                    .describe("Optional schema name to filter by. Omit to list all schemas."),
                profile: profileParam(ctx),
            },
        },
        async ({ schema, profile }) =>
            runTool("list_tables", async () => {
                const tables = await resolveAdapter(ctx, profile).listTables(schema);
                return jsonResponse(tables);
            }),
    );
}
