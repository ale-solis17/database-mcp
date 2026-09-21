import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, profileParam, resolveAdapter, runTool } from "./tool-helpers.js";

export function registerDescribeTableTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "describe_table",
        {
            description:
                "Describe a table: columns (type, nullable, default), primary key, foreign keys, indexes and comments.",
            inputSchema: {
                schema: z
                    .string()
                    .default("public")
                    .describe("Schema the table belongs to. Defaults to \"public\"."),
                table: z.string().describe("Table name to describe."),
                profile: profileParam(ctx),
            },
        },
        async ({ schema, table, profile }) =>
            runTool("describe_table", async () => {
                const description = await resolveAdapter(ctx, profile).describeTable(schema, table);
                return jsonResponse(description);
            }),
    );
}
