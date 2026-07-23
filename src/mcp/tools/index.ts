import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/mcp.types.js";
import { registerListSchemasTool } from "./list-schemas.tool.js";
import { registerListTablesTool } from "./list-tables.tool.js";
import { registerDescribeTableTool } from "./describe-table.tool.js";
import { registerExecuteSelectTool } from "./execute-select.tool.js";
import { registerGetTableDdlTool } from "./get-table-ddl.tool.js";
import { registerGetRelationshipsTool } from "./get-relationships.tool.js";
import { registerListViewsTool } from "./list-views.tool.js";
import { registerGetViewDefinitionTool } from "./get-view-definition.tool.js";
import { registerListProceduresTool } from "./list-procedures.tool.js";
import { registerGetProcedureDefinitionTool } from "./get-procedure-definition.tool.js";
import { registerGetDatabaseOverviewTool } from "./get-database-overview.tool.js";

/**
 * Registers every MCP tool against the server.
 *
 * Adding a new tool = write a `register<Name>Tool` module and call it here.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
    // Discovery
    registerListSchemasTool(server, ctx);
    registerListTablesTool(server, ctx);
    registerDescribeTableTool(server, ctx);
    // Read-only queries
    registerExecuteSelectTool(server, ctx);
    // Structure & context
    registerGetTableDdlTool(server, ctx);
    registerGetRelationshipsTool(server, ctx);
    registerListViewsTool(server, ctx);
    registerGetViewDefinitionTool(server, ctx);
    registerListProceduresTool(server, ctx);
    registerGetProcedureDefinitionTool(server, ctx);
    registerGetDatabaseOverviewTool(server, ctx);
}
