import { Pool } from "pg";
import { ArgError, parseProfileArgs, usage } from "./cli-args.js";
import { ConfigError, getProfilesConfig } from "./config/databases.js";
import type { DatabaseConfig, ProfileConfig } from "./types/database.types.js";

/**
 * Verifies the configured database users look READ-ONLY.
 *
 * This inspects granted privileges rather than performing any write, so it is
 * always safe to run. With no arguments it audits EVERY profile: with several
 * databases configured, a profile left unaudited is the actual risk.
 *
 * Exit codes (in precedence order):
 *   1 — a profile could not be checked (connection/config error). This wins,
 *       because an unaudited profile is unknown, not safe.
 *   2 — every profile was checked and at least one has write capability
 *   0 — every profile was checked and all look read-only
 *
 * Human-readable findings are written to stderr.
 */

interface Audit {
    profile: string;
    warnings: string[];
    error?: string;
}

async function auditProfile(name: string, cfg: DatabaseConfig): Promise<Audit> {
    // The raw pool, not the adapter: this needs pg_roles and
    // information_schema, which are not part of the adapter surface.
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

        process.stderr.write(`[${name}] connected as: ${currentUser}\n`);
        return { profile: name, warnings };
    } catch (err) {
        return {
            profile: name,
            warnings: [],
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        await pool.end().catch(() => undefined);
    }
}

async function run(): Promise<void> {
    let args;
    try {
        args = parseProfileArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(
            `${err instanceof ArgError ? err.message : String(err)}\n\n` +
                `${usage("dist/verify-permissions.js", "audit every profile")}\n`,
        );
        process.exit(1);
    }

    if (args.help) {
        process.stderr.write(`${usage("dist/verify-permissions.js", "audit every profile")}\n`);
        process.exit(0);
    }

    const config = getProfilesConfig();

    let targets: ProfileConfig[];
    if (args.profile !== undefined) {
        const found = config.profiles.find((p) => p.name === args.profile);
        if (!found) {
            const names = config.profiles.map((p) => p.name).join(", ");
            process.stderr.write(
                `Unknown database profile "${args.profile}".\nConfigured profiles: ${names}.\n`,
            );
            process.exit(1);
        }
        targets = [found];
    } else {
        // Default and --all are the same thing here: audit everything.
        targets = [...config.profiles];
    }

    // Sequential, not Promise.all: interleaved output would make it impossible
    // to tell which profile a finding belongs to.
    const audits: Audit[] = [];
    for (const target of targets) {
        const audit = await auditProfile(target.name, target.config);
        audits.push(audit);

        if (audit.error) {
            process.stderr.write(`[${audit.profile}] could not verify: ${audit.error}\n`);
        } else if (audit.warnings.length === 0) {
            process.stderr.write(`[${audit.profile}] OK - user appears to be READ-ONLY.\n`);
        } else {
            process.stderr.write(`[${audit.profile}] WARNING - user is NOT strictly read-only:\n`);
            for (const w of audit.warnings) {
                process.stderr.write(`[${audit.profile}]   - ${w}\n`);
            }
        }
    }

    const errored = audits.filter((a) => a.error);
    const writable = audits.filter((a) => !a.error && a.warnings.length > 0);
    const readOnly = audits.filter((a) => !a.error && a.warnings.length === 0);

    const summary = [`${audits.length} profile(s) checked`, `${readOnly.length} read-only`];
    if (writable.length > 0) {
        summary.push(`${writable.length} with write privileges (${writable.map((a) => a.profile).join(", ")})`);
    }
    if (errored.length > 0) {
        summary.push(`${errored.length} could not be checked (${errored.map((a) => a.profile).join(", ")})`);
    }
    process.stderr.write(`${summary.join(", ")}.\n`);

    if (writable.length > 0) {
        process.stderr.write(
            "  Create a dedicated read-only user for those (see docs/security.md).\n",
        );
    }

    // Precedence: an unchecked profile is unknown, not safe, so it dominates.
    if (errored.length > 0) process.exit(1);
    if (writable.length > 0) process.exit(2);
    process.exit(0);
}

run().catch((err) => {
    process.stderr.write(
        err instanceof ConfigError
            ? `\n${err.message}\n\n`
            : `Could not verify permissions: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
});
