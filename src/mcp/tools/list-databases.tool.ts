import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../types/mcp.types.js";
import { jsonResponse, runTool } from "./tool-helpers.js";

export function registerListDatabasesTool(server: McpServer, ctx: ToolContext): void {
    server.registerTool(
        "list_databases",
        {
            description:
                "List the database profiles this server can query, with their descriptions and " +
                "which one is the default. Use this first when a question might concern a " +
                'database other than the default, then pass the chosen name as the "profile" ' +
                "argument of any other tool.",
        },
        async () =>
            runTool("list_databases", async () =>
                jsonResponse({
                    defaultProfile: ctx.registry.defaultProfile,
                    profiles: ctx.registry.profiles.map((p) => ({
                        // SECURITY: built field by field from an allowlist, on purpose.
                        // Never spread `p.config` — that would hand the model (and the
                        // transcript) the password. Never echo a profile's raw `url`
                        // either: the credentials are embedded in it.
                        name: p.name,
                        isDefault: p.name === ctx.registry.defaultProfile,
                        description: p.description ?? null,
                        engine: p.config.type,
                        database: p.config.database,
                        host: p.config.host,
                        port: p.config.port,
                        user: p.config.user,
                        ssl: p.config.ssl ?? false,
                        status: ctx.registry.statusOf(p.name),
                    })),
                }),
            ),
    );
}
