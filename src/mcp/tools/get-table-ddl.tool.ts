import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { profileParam, resolveAdapter, runTool, textResponse } from "./tool-helpers.js";

export function registerGetTableDdlTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "get_table_ddl",
        {
            description:
                "Get an equivalent CREATE TABLE DDL for a table, including columns, primary key, foreign keys, indexes and comments.",
            inputSchema: {
                schema: z.string().default("public").describe("Schema the table belongs to."),
                table: z.string().describe("Table name."),
                profile: profileParam(ctx),
            },
        },
        async ({ schema, table, profile }) =>
            runTool("get_table_ddl", async () => {
                const ddl = await resolveAdapter(ctx, profile).getTableDDL(schema, table);
                return textResponse(ddl);
            }),
    );
}
