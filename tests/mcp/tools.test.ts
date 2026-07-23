import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DatabaseAdapter } from "../../src/database/database.adapter.js";
import type {
    DatabaseOverview,
    QueryResultData,
    RelationshipInfo,
    RoutineInfo,
    SchemaInfo,
    TableDescription,
    TableInfo,
    ViewInfo,
} from "../../src/types/database.types.js";

// Minimal fake adapter so the MCP layer can be tested without a live database.
class FakeAdapter implements DatabaseAdapter {
    async testConnection(): Promise<boolean> {
        return true;
    }
    async executeSelect(): Promise<QueryResultData> {
        return { columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
    }
    async listSchemas(): Promise<SchemaInfo[]> {
        return [{ name: "public" }, { name: "sales" }];
    }
    async listTables(schema?: string): Promise<TableInfo[]> {
        const all: TableInfo[] = [
            { schema: "public", name: "users", type: "table", comment: null },
            { schema: "sales", name: "orders", type: "table", comment: "order records" },
        ];
        return schema ? all.filter((t) => t.schema === schema) : all;
    }
    async describeTable(schema: string, table: string): Promise<TableDescription> {
        return {
            schema,
            table,
            comment: null,
            columns: [
                { name: "id", dataType: "integer", nullable: false, default: null, position: 1 },
            ],
            primaryKey: { constraintName: `${table}_pkey`, columns: ["id"] },
            foreignKeys: [],
            indexes: [],
        };
    }
    async getTableDDL(): Promise<string> {
        return "CREATE TABLE ...";
    }
    async getRelationships(): Promise<RelationshipInfo[]> {
        return [];
    }
    async listViews(): Promise<ViewInfo[]> {
        return [];
    }
    async getViewDefinition(): Promise<string> {
        return "SELECT 1";
    }
    async listProcedures(): Promise<RoutineInfo[]> {
        return [];
    }
    async getProcedureDefinition(): Promise<string> {
        return "BEGIN END";
    }
    async getDatabaseOverview(): Promise<DatabaseOverview> {
        return { database: "test", schemas: [], relationships: [], truncated: false };
    }
    async close(): Promise<void> {}
}

describe("mcp tools", () => {
    let client: Client;

    before(async () => {
        // Satisfy env validation without a real .env.
        process.env.DB_HOST ??= "localhost";
        process.env.DB_NAME ??= "test";
        process.env.DB_USER ??= "test";
        process.env.DB_PASSWORD ??= "test";

        const { createMcpServer } = await import("../../src/mcp/server.js");
        const server = createMcpServer({
            adapter: new FakeAdapter(),
            limits: { maxRows: 100, queryTimeoutMs: 5000, maxResultSizeMb: 5 },
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        client = new Client({ name: "test-client", version: "1.0.0" });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
    });

    after(async () => {
        await client.close();
    });

    it("exposes the phase-3 tools", async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        assert.ok(names.includes("list_schemas"));
        assert.ok(names.includes("list_tables"));
        assert.ok(names.includes("describe_table"));
    });

    it("list_schemas returns schema names", async () => {
        const res = await client.callTool({ name: "list_schemas", arguments: {} });
        const text = (res.content as { type: string; text: string }[])[0].text;
        const parsed = JSON.parse(text) as SchemaInfo[];
        assert.deepEqual(parsed.map((s) => s.name), ["public", "sales"]);
    });

    it("list_tables filters by schema", async () => {
        const res = await client.callTool({
            name: "list_tables",
            arguments: { schema: "sales" },
        });
        const text = (res.content as { type: string; text: string }[])[0].text;
        const parsed = JSON.parse(text) as TableInfo[];
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].name, "orders");
    });

    it("describe_table returns a primary key", async () => {
        const res = await client.callTool({
            name: "describe_table",
            arguments: { schema: "public", table: "users" },
        });
        const text = (res.content as { type: string; text: string }[])[0].text;
        const parsed = JSON.parse(text) as TableDescription;
        assert.deepEqual(parsed.primaryKey?.columns, ["id"]);
    });

    it("exposes all phase-5 context tools", async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        for (const expected of [
            "execute_select",
            "get_table_ddl",
            "get_relationships",
            "list_views",
            "get_view_definition",
            "list_procedures",
            "get_procedure_definition",
            "get_database_overview",
        ]) {
            assert.ok(names.includes(expected), `missing tool: ${expected}`);
        }
    });

    it("execute_select rejects a write via the tool boundary", async () => {
        const res = await client.callTool({
            name: "execute_select",
            arguments: { query: "DELETE FROM users" },
        });
        assert.equal(res.isError, true);
        const text = (res.content as { type: string; text: string }[])[0].text;
        assert.match(text, /write operations are not allowed/i);
    });

    it("get_database_overview returns structured overview", async () => {
        const res = await client.callTool({ name: "get_database_overview", arguments: {} });
        const text = (res.content as { type: string; text: string }[])[0].text;
        const parsed = JSON.parse(text) as { database: string };
        assert.equal(parsed.database, "test");
    });
});
