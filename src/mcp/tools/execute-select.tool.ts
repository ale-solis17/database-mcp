import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, runTool } from "./tool-helpers.js";
import { validateSelectQuery } from "../../security/query-validator.js";

export function registerExecuteSelectTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "execute_select",
        {
            description:
                "Execute a READ-ONLY SELECT query and return structured rows. " +
                "Only single SELECT/WITH statements are allowed; any write, DDL or DCL operation is rejected. " +
                `Results are capped at ${ctx.limits.maxRows} rows.`,
            inputSchema: {
                query: z
                    .string()
                    .describe("A single read-only SELECT (or WITH ... SELECT) statement."),
            },
        },
        async ({ query }) =>
            runTool("execute_select", async () => {
                // Layer A/B: reject anything that is not a single read-only SELECT.
                const validated = validateSelectQuery(query);
                // Layer C: adapter runs it inside a READ ONLY transaction with limits.
                const result = await ctx.adapter.executeSelect(validated, ctx.limits);
                return jsonResponse(result);
            }),
    );
}
