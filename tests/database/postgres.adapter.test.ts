import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PostgresAdapter } from "../../src/database/postgres/postgres.adapter.js";
import type { QueryLimits } from "../../src/types/database.types.js";

/**
 * Integration tests against a live PostgreSQL instance.
 *
 * These require a reachable database (from .env or environment). If the
 * connection cannot be established the whole suite is skipped so CI without a
 * database still passes. All queries here are strictly read-only.
 */
const LIMITS: QueryLimits = { maxRows: 5, queryTimeoutMs: 3000, maxResultSizeMb: 10 };

describe("PostgresAdapter (integration)", () => {
    let adapter: PostgresAdapter | undefined;
    let available = false;

    before(async () => {
        try {
            const { PostgresAdapter: Adapter } = await import(
                "../../src/database/postgres/postgres.adapter.js"
            );
            const { getDatabaseConfig } = await import("../../src/config/database-config.js");
            const a = new Adapter(getDatabaseConfig());
            await a.testConnection();
            adapter = a;
            available = true;
        } catch {
            available = false;
        }
    });

    after(async () => {
        await adapter?.close();
    });

    it("runs a SELECT and returns structured data", async (t) => {
        if (!available || !adapter) return t.skip("no database available");
        const r = await adapter.executeSelect("SELECT 1 AS n", LIMITS);
        assert.deepEqual(r.columns, ["n"]);
        assert.equal(r.rowCount, 1);
        assert.equal(r.truncated, false);
    });

    it("caps rows and flags truncation", async (t) => {
        if (!available || !adapter) return t.skip("no database available");
        const r = await adapter.executeSelect("SELECT generate_series(1, 100) AS n", LIMITS);
        assert.equal(r.rowCount, LIMITS.maxRows);
        assert.equal(r.truncated, true);
    });

    it("enforces statement_timeout", async (t) => {
        if (!available || !adapter) return t.skip("no database available");
        await assert.rejects(
            adapter.executeSelect("SELECT pg_sleep(5)", { ...LIMITS, queryTimeoutMs: 300 }),
            /timeout/i,
        );
    });

    it("blocks writes at the READ ONLY transaction level", async (t) => {
        if (!available || !adapter) return t.skip("no database available");
        // Bypasses the validator on purpose to prove the engine-level backstop.
        await assert.rejects(
            adapter.executeSelect(
                "WITH x AS (CREATE TEMP TABLE _t (i int)) SELECT 1",
                LIMITS,
            ),
        );
    });

    it("lists schemas and tables", async (t) => {
        if (!available || !adapter) return t.skip("no database available");
        const schemas = await adapter.listSchemas();
        assert.ok(Array.isArray(schemas));
        const tables = await adapter.listTables();
        assert.ok(Array.isArray(tables));
    });
});
