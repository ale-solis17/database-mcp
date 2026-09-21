import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadProfilesConfig } from "../../src/config/databases.js";
import type { ProfilesConfig } from "../../src/types/database.types.js";

/**
 * Pure tests: no live database, and `process.env` is never mutated — the
 * loader takes both the file path and the variable source by injection.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

function load(name: string, env: NodeJS.ProcessEnv = {}): ProfilesConfig {
    return loadProfilesConfig({ path: fixture(name), env });
}

function expectError(name: string, env: NodeJS.ProcessEnv = {}): string {
    try {
        load(name, env);
    } catch (err) {
        assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
        return err.message;
    }
    throw new Error(`expected ${name} to fail, but it loaded`);
}

describe("databases.json — discrete fields", () => {
    const env = { TEST_REMOTE_PASSWORD: "s3cret" };

    it("maps fields onto a DatabaseConfig", () => {
        const { profiles } = load("valid.json", env);
        const remote = profiles.find((p) => p.name === "remote")!;
        assert.equal(remote.config.host, "db.example.com");
        assert.equal(remote.config.database, "appdb");
        assert.equal(remote.config.user, "mcp_readonly");
        assert.equal(remote.config.port, 5432, "port defaults to 5432");
        assert.equal(remote.description, "Remote database");
    });

    it("enables ssl for remote hosts and disables it for localhost", () => {
        const { profiles } = load("valid.json", env);
        assert.equal(profiles.find((p) => p.name === "remote")!.config.ssl, true);
        assert.equal(profiles.find((p) => p.name === "nearby")!.config.ssl, false);
    });

    it("puts the default profile first and records where it loaded from", () => {
        const config = load("valid.json", env);
        assert.equal(config.defaultProfile, "remote");
        assert.equal(config.profiles[0]!.name, "remote");
        assert.ok(config.sourcePath.endsWith("valid.json"));
    });

    it("ignores $schema and _-prefixed documentation keys", () => {
        // valid.json carries $schema, _readme and a per-profile _comment. The
        // _readme even mentions ${NOT_A_REAL_VAR}, which must NOT be treated as
        // an undefined variable.
        const config = load("valid.json", env);
        assert.equal(config.profiles.length, 2);
    });
});

describe("databases.json — ${VAR} interpolation", () => {
    it("substitutes from the injected environment", () => {
        const { profiles } = load("valid.json", { TEST_REMOTE_PASSWORD: "s3cret" });
        assert.equal(profiles.find((p) => p.name === "remote")!.config.password, "s3cret");
    });

    it("handles passwords containing $ and @", () => {
        const password = "p$a@ss/word#1";
        const { profiles } = load("valid.json", { TEST_REMOTE_PASSWORD: password });
        assert.equal(profiles.find((p) => p.name === "remote")!.config.password, password);
    });

    it("treats $${VAR} as a literal", () => {
        const { profiles } = load("escaped-var.json", { NOT_EXPANDED: "should-not-appear" });
        assert.equal(profiles[0]!.config.password, "${NOT_EXPANDED}");
    });

    it("reports every missing variable at once, with its location", () => {
        const message = expectError("missing-vars.json");
        assert.match(message, /TEST_ABSENT_A/);
        assert.match(message, /TEST_ABSENT_B/, "should list all missing vars, not just the first");
        assert.match(message, /profiles\.one\.password/, "should say where the variable is used");
        assert.match(message, /profiles\.two\.url/);
    });

    it("treats an empty variable as unset", () => {
        const message = expectError("missing-vars.json", { TEST_ABSENT_A: "  " });
        assert.match(message, /TEST_ABSENT_A/);
    });
});

describe("databases.json — connection-string form", () => {
    const env = {
        TEST_MAIN_URL: "postgresql://mcp%40user:p%2Fw%40rd@db.example.com:6543/maindb?sslmode=require",
    };

    it("decodes percent-encoded credentials", () => {
        const { profiles } = load("url.json", env);
        const main = profiles.find((p) => p.name === "main")!;
        assert.equal(main.config.user, "mcp@user");
        assert.equal(main.config.password, "p/w@rd");
        assert.equal(main.config.host, "db.example.com");
        assert.equal(main.config.port, 6543);
        assert.equal(main.config.database, "maindb");
    });

    it("maps sslmode onto ssl", () => {
        const { profiles } = load("url.json", env);
        assert.equal(profiles.find((p) => p.name === "main")!.config.ssl, true, "sslmode=require");
        assert.equal(
            profiles.find((p) => p.name === "insecure")!.config.ssl,
            false,
            "sslmode=disable",
        );
    });

    it("lets an explicit ssl field override sslmode", () => {
        const { profiles } = load("url.json", env);
        assert.equal(profiles.find((p) => p.name === "overridden")!.config.ssl, false);
    });

    it("rejects a non-postgres protocol", () => {
        const message = expectError("bad-url.json");
        assert.match(message, /mysql/);
        assert.match(message, /postgres/);
    });

    it("rejects a url with no database name", () => {
        assert.match(expectError("url-no-db.json"), /database name/i);
    });
});

describe("databases.json — validation errors", () => {
    it("names an unknown key and suggests the right one", () => {
        const message = expectError("typo-key.json");
        assert.match(message, /hosts/);
        assert.match(message, /did you mean "host"/i);
    });

    it("rejects an empty profiles object", () => {
        assert.match(expectError("empty-profiles.json"), /no profiles/i);
    });

    it("requires defaultProfile once there is more than one profile", () => {
        const message = expectError("two-no-default.json");
        assert.match(message, /defaultProfile/);
        assert.match(message, /one, two/);
    });

    it("infers defaultProfile when there is exactly one profile", () => {
        const config = load("single-no-default.json");
        assert.equal(config.defaultProfile, "only");
    });

    it("rejects a defaultProfile that names no profile", () => {
        const message = expectError("unknown-default.json");
        assert.match(message, /ghost/);
        assert.match(message, /one/);
    });

    it("rejects an invalid profile name and suggests a slug", () => {
        const message = expectError("bad-name.json");
        assert.match(message, /My DB/);
        assert.match(message, /my_db/);
    });

    it("names the path when the file does not exist", () => {
        const message = expectError("does-not-exist.json");
        assert.match(message, /does-not-exist\.json/);
    });
});
