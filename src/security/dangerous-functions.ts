/**
 * Denylist of PostgreSQL functions that are read-only at the transaction level
 * but still dangerous: server-side file access, network calls, large-object
 * I/O, session/admin control, or denial-of-service. These are blocked as an
 * extra defense layer even though they may not trigger the READ ONLY guard.
 */
export const DANGEROUS_FUNCTIONS: string[] = [
    // Denial of service
    "pg_sleep",
    "pg_sleep_for",
    "pg_sleep_until",
    // Server-side filesystem access
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "pg_ls_logdir",
    "pg_ls_waldir",
    // Large object I/O (can read/write server files)
    "lo_import",
    "lo_export",
    "lo_get",
    "lo_put",
    "lo_from_bytea",
    "loread",
    "lowrite",
    // Cross-database / network access
    "dblink",
    "dblink_exec",
    "dblink_connect",
    "postgres_fdw_handler",
    // Session / server administration
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "pg_create_restore_point",
    "set_config",
    "pg_stat_reset",
];

export class DangerousFunctionError extends Error {
    constructor(fn: string) {
        super(`Query rejected: use of a restricted function is not allowed (${fn}).`);
        this.name = "DangerousFunctionError";
    }
}

/**
 * Scans already comment-stripped, string-masked SQL for a call to any denied
 * function matched as `name(` with optional whitespace). Throws on the first
 * match.
 */
export function assertNoDangerousFunctions(maskedSql: string): void {
    const lowered = maskedSql.toLowerCase();
    for (const fn of DANGEROUS_FUNCTIONS) {
        // Word boundary before the name, optional whitespace, then "(".
        const re = new RegExp(`(?<![a-z0-9_.])${fn}\\s*\\(`, "i");
        if (re.test(lowered)) {
            throw new DangerousFunctionError(fn);
        }
    }
}
