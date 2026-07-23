import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Smoke test: verifies the test runner (node:test + tsx) is wired up and that
 * core config/type modules load without side effects requiring a live DB.
 */
describe("foundation", () => {
    it("runs the test runner", () => {
        assert.equal(1 + 1, 2);
    });

    it("loads env with required vars present", async () => {
        process.env.DB_HOST ??= "localhost";
        process.env.DB_NAME ??= "postgres";
        process.env.DB_USER ??= "postgres";
        process.env.DB_PASSWORD ??= "postgres";

        const { env } = await import("../src/config/env.js");
        assert.equal(typeof env.database.host, "string");
        assert.ok(env.limits.maxRows > 0);
        assert.equal(env.mcp.name.length > 0, true);
    });

    it("builds a database config for postgres", async () => {
        const { getDatabaseConfig, getQueryLimits } = await import(
            "../src/config/database-config.js"
        );
        const cfg = getDatabaseConfig();
        assert.equal(cfg.type, "postgres");
        assert.ok(getQueryLimits().queryTimeoutMs > 0);
    });
});
