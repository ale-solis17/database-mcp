import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DatabaseAdapter } from "../../src/database/database.adapter.js";
import type {
    ConnectionRegistry,
    ProfileStatus,
} from "../../src/database/connection-registry.js";
import { UnknownProfileError } from "../../src/database/connection-registry.js";
import type {
    DatabaseOverview,
    ProfileConfig,
    QueryResultData,
    RelationshipInfo,
    RoutineInfo,
    SchemaInfo,
    TableDescription,
    TableInfo,
    ViewInfo,
} from "../../src/types/database.types.js";

const FAKE_PASSWORD = "sup3r-s3cret-should-never-surface";

/**
 * Minimal fake adapter so the MCP layer can be tested without a live database.
 *
 * Every result is derived from `tag`, so a test can prove a tool call reached
 * the profile it asked for rather than some other one.
 */
class FakeAdapter implements DatabaseAdapter {
    constructor(private readonly tag: string) {}

    async testConnection(): Promise<boolean> {
        return true;
    }
    async executeSelect(): Promise<QueryResultData> {
        return { columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
    }
    async listSchemas(): Promise<SchemaInfo[]> {
        return [{ name: `${this.tag}_public` }, { name: `${this.tag}_sales` }];
    }
    async listTables(schema?: string): Promise<TableInfo[]> {
        const all: TableInfo[] = [
            { schema: "public", name: `${this.tag}_users`, type: "table", comment: null },
            { schema: "sales", name: `${this.tag}_orders`, type: "table", comment: "orders" },
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
        return { database: this.tag, schemas: [], relationships: [], truncated: false };
    }
    async close(): Promise<void> {}
}

function profile(name: string, description: string): ProfileConfig {
    return {
        name,
        description,
        config: {
            type: "postgres",
            host: `${name}.example.test`,
            port: 5432,
            database: `${name}_db`,
            user: "mcp_readonly",
            password: FAKE_PASSWORD,
            ssl: true,
        },
    };
}

/** In-memory registry: the interface needs no `pg`, so no database is involved. */
function fakeRegistry(names: string[], defaultProfile: string): ConnectionRegistry {
    const profiles = names.map((n) => profile(n, `the ${n} database`));
    const adapters = new Map(names.map((n) => [n, new FakeAdapter(n) as DatabaseAdapter]));
    return {
        defaultProfile,
        profiles,
        get(name?: string): DatabaseAdapter {
            const key = name ?? defaultProfile;
            const adapter = adapters.get(key);
            if (!adapter) {
                throw new UnknownProfileError(
                    `Unknown database profile "${key}".\nConfigured profiles: ${names.join(", ")}.`,
                );
            }
            return adapter;
        },
        statusOf(): ProfileStatus {
            return { state: "idle" };
        },
        async closeAll(): Promise<void> {},
    };
}

function textOf(res: unknown): string {
    return ((res as { content: { type: string; text: string }[] }).content)[0]!.text;
}

describe("mcp tools", () => {
    let client: Client;

    before(async () => {
        const { createMcpServer } = await import("../../src/mcp/server.js");
        const server = createMcpServer({
            registry: fakeRegistry(["a", "b"], "a"),
            limits: { maxRows: 100, queryTimeoutMs: 5000, maxResultSizeMb: 5 },
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        client = new Client({ name: "test-client", version: "1.0.0" });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    });

    after(async () => {
        await client.close();
    });

    it("exposes the discovery tools", async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        assert.ok(names.includes("list_databases"));
        assert.ok(names.includes("list_schemas"));
        assert.ok(names.includes("list_tables"));
        assert.ok(names.includes("describe_table"));
    });

    it("list_schemas returns schema names", async () => {
        const res = await client.callTool({ name: "list_schemas", arguments: {} });
        const parsed = JSON.parse(textOf(res)) as SchemaInfo[];
        assert.deepEqual(
            parsed.map((s) => s.name),
            ["a_public", "a_sales"],
        );
    });

    it("list_tables filters by schema", async () => {
        const res = await client.callTool({
            name: "list_tables",
            arguments: { schema: "sales" },
        });
        const parsed = JSON.parse(textOf(res)) as TableInfo[];
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0]!.name, "a_orders");
    });

    it("describe_table returns a primary key", async () => {
        const res = await client.callTool({
            name: "describe_table",
            arguments: { schema: "public", table: "users" },
        });
        const parsed = JSON.parse(textOf(res)) as TableDescription;
        assert.deepEqual(parsed.primaryKey?.columns, ["id"]);
    });

    it("exposes all context tools", async () => {
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
        assert.match(textOf(res), /write operations are not allowed/i);
    });

    it("get_database_overview returns structured overview", async () => {
        const res = await client.callTool({ name: "get_database_overview", arguments: {} });
        const parsed = JSON.parse(textOf(res)) as { database: string };
        assert.equal(parsed.database, "a");
    });

    // --- profile routing -------------------------------------------------

    it("routes to the requested profile", async () => {
        const res = await client.callTool({
            name: "list_tables",
            arguments: { profile: "b" },
        });
        const parsed = JSON.parse(textOf(res)) as TableInfo[];
        assert.deepEqual(
            parsed.map((t) => t.name),
            ["b_users", "b_orders"],
        );
    });

    it("falls back to the default profile when none is given", async () => {
        const res = await client.callTool({ name: "list_tables", arguments: {} });
        const parsed = JSON.parse(textOf(res)) as TableInfo[];
        assert.deepEqual(
            parsed.map((t) => t.name),
            ["a_users", "a_orders"],
        );
    });

    // get_database_overview and list_schemas had NO inputSchema before profiles
    // existed, so they are the two most likely to have been missed.
    it("accepts a profile on tools that previously took no arguments", async () => {
        const overview = await client.callTool({
            name: "get_database_overview",
            arguments: { profile: "b" },
        });
        assert.equal((JSON.parse(textOf(overview)) as { database: string }).database, "b");

        const schemas = await client.callTool({
            name: "list_schemas",
            arguments: { profile: "b" },
        });
        assert.deepEqual(
            (JSON.parse(textOf(schemas)) as SchemaInfo[]).map((s) => s.name),
            ["b_public", "b_sales"],
        );
    });

    it("advertises the profile names in the tool schema", async () => {
        const { tools } = await client.listTools();
        for (const name of ["list_tables", "list_schemas", "get_database_overview"]) {
            const tool = tools.find((t) => t.name === name);
            assert.ok(tool, `missing tool: ${name}`);
            const properties = (
                tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }
            ).properties;
            assert.deepEqual(properties?.profile?.enum, ["a", "b"], `bad enum on ${name}`);
        }
    });

    it("rejects an unknown profile without killing the session", async () => {
        const res = await client.callTool({
            name: "list_tables",
            arguments: { profile: "nope" },
        });
        assert.equal(res.isError, true);
        // With a closed `z.enum` the SDK rejects the call before our own
        // message runs. Either way the response must name the valid profiles,
        // so a wrong guess costs one call rather than leaving the model stuck.
        const message = textOf(res);
        assert.match(message, /profile/i);
        assert.match(message, /"a"/);
        assert.match(message, /"b"/);

        // The session still works afterwards.
        const after = await client.callTool({ name: "list_tables", arguments: {} });
        assert.notEqual(after.isError, true);
    });

    // --- list_databases --------------------------------------------------

    it("list_databases reports both profiles and marks the default", async () => {
        const res = await client.callTool({ name: "list_databases", arguments: {} });
        const parsed = JSON.parse(textOf(res)) as {
            defaultProfile: string;
            profiles: { name: string; isDefault: boolean; description: string | null }[];
        };
        assert.equal(parsed.defaultProfile, "a");
        assert.deepEqual(
            parsed.profiles.map((p) => p.name),
            ["a", "b"],
        );
        assert.deepEqual(
            parsed.profiles.map((p) => p.isDefault),
            [true, false],
        );
        assert.equal(parsed.profiles[0]!.description, "the a database");
    });

    it("list_databases never leaks credentials", async () => {
        const res = await client.callTool({ name: "list_databases", arguments: {} });
        const serialized = JSON.stringify(res);
        assert.ok(!serialized.includes(FAKE_PASSWORD), "password leaked into list_databases");
        assert.ok(!serialized.includes("://"), "a connection string leaked into list_databases");
    });
});
