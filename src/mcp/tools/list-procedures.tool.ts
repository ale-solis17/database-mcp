import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, runTool } from "./tool-helpers.js";

export function registerListProceduresTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "list_procedures",
        {
            description:
                "List stored functions and procedures (kind distinguishes 'function' vs 'procedure'), with return type, argument signature and language. Optionally filtered to a schema.",
            inputSchema: {
                schema: z.string().optional().describe("Optional schema name to filter by."),
            },
        },
        async ({ schema }) =>
            runTool("list_procedures", async () => {
                const routines = await ctx.adapter.listProcedures(schema);
                return jsonResponse(routines);
            }),
    );
}
