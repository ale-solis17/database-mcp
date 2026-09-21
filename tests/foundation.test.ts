import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Smoke test: verifies the test runner (node:test + tsx) is wired up and that
 * core config modules load without side effects requiring a live DB.
 */
describe("foundation", () => {
    it("runs the test runner", () => {
        assert.equal(1 + 1, 2);
    });

    it("loads env with no database variables present", async () => {
        // Nothing is seeded: since connections moved to databases.json, env.ts
        // has no required variables and must not throw on a bare environment.
        const { env } = await import("../src/config/env.js");
        assert.ok(env.limits.maxRows > 0);
        assert.equal(env.mcp.name.length > 0, true);
    });

    it("no longer exposes a single-database surface", async () => {
        // Regression guard: env.database is gone for good. A leftover would mean
        // some code path can still silently read DB_HOST and friends.
        const { env } = await import("../src/config/env.js");
        assert.ok(!("database" in env));
    });

    it("builds query limits", async () => {
        const { getQueryLimits } = await import("../src/config/database-config.js");
        assert.ok(getQueryLimits().queryTimeoutMs > 0);
    });
});
