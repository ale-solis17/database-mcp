import { Pool } from "pg";
import { getDatabaseConfig } from "./config/database-config.js";

/**
 * Verifies the configured database user looks READ-ONLY.
 *
 * This inspects granted privileges rather than performing any write, so it is
 * always safe to run. Exit codes:
 *   0 — user appears read-only (no write grants, not a superuser)
 *   2 — user has write capability (warning; setup can still continue)
 *   1 — could not connect / unexpected error
 *
 * Human-readable findings are written to stderr.
 */
async function run(): Promise<void> {
    const cfg = getDatabaseConfig();
    const pool = new Pool({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 10_000,
    });

    try {
        const who = await pool.query<{ user: string }>("SELECT current_user AS user");
        const currentUser = who.rows[0]?.user ?? cfg.user;

        const roleInfo = await pool.query<{
            rolsuper: boolean;
            rolcreatedb: boolean;
            rolcreaterole: boolean;
        }>(
            `SELECT rolsuper, rolcreatedb, rolcreaterole
               FROM pg_roles WHERE rolname = current_user`,
        );
        const role = roleInfo.rows[0];

        const writeGrants = await pool.query<{ privilege_type: string }>(
            `SELECT DISTINCT privilege_type
               FROM information_schema.role_table_grants
              WHERE grantee = current_user
                AND privilege_type IN
                    ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`,
        );

        const warnings: string[] = [];
        if (role?.rolsuper) warnings.push("user is a SUPERUSER");
        if (role?.rolcreatedb) warnings.push("user has CREATEDB");
        if (role?.rolcreaterole) warnings.push("user has CREATEROLE");
        if (writeGrants.rowCount && writeGrants.rowCount > 0) {
            warnings.push(
                `user holds write privileges: ${writeGrants.rows
                    .map((r) => r.privilege_type)
                    .join(", ")}`,
            );
        }

        process.stderr.write(`Connected as: ${currentUser}\n`);
        if (warnings.length === 0) {
            process.stderr.write("✔ User appears to be READ-ONLY.\n");
            process.exit(0);
        } else {
            process.stderr.write("⚠ User is NOT strictly read-only:\n");
            for (const w of warnings) process.stderr.write(`  - ${w}\n`);
            process.stderr.write(
                "  Consider creating a dedicated read-only user (see docs/security.md).\n",
            );
            process.exit(2);
        }
    } catch (err) {
        process.stderr.write(
            `Could not verify permissions: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
    } finally {
        await pool.end().catch(() => undefined);
    }
}

void run();
