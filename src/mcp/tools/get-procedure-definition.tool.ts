import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types/mcp.types.js";
import { textResponse, runTool } from "./tool-helpers.js";

export function registerGetProcedureDefinitionTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "get_procedure_definition",
        {
            description:
                "Get the source definition of a function or procedure for INSPECTION only (it is never executed). Overloaded names return all matching signatures.",
            inputSchema: {
                schema: z.string().default("public").describe("Schema the routine belongs to."),
                name: z.string().describe("Function or procedure name."),
            },
        },
        async ({ schema, name }) =>
            runTool("get_procedure_definition", async () => {
                const def = await ctx.adapter.getProcedureDefinition(schema, name);
                return textResponse(def);
            }),
    );
}
