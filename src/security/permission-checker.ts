import type { SqlStatement } from "./sql-parser.js";

/**
 * Read-only permission policy.
 *
 * The ONLY statement type allowed is `select` (which also covers `WITH ... SELECT`
 * CTEs, since node-sql-parser types those as `select`). Everything else is
 * rejected with a specific, safe message.
 */

/** Statement `type` values that are explicitly write/DDL/DCL operations. */
const FORBIDDEN_STATEMENT_TYPES: Record<string, string> = {
    insert: "INSERT",
    update: "UPDATE",
    delete: "DELETE",
    replace: "REPLACE",
    drop: "DROP",
    alter: "ALTER",
    truncate: "TRUNCATE",
    create: "CREATE",
    grant: "GRANT",
    revoke: "REVOKE",
    comment: "COMMENT",
    call: "CALL",
    use: "USE",
    set: "SET",
    lock: "LOCK",
    vacuum: "VACUUM",
    analyze: "ANALYZE",
    copy: "COPY",
    merge: "MERGE",
};

/**
 * Keywords that must never appear as the leading token of a statement, used by
 * the textual fallback when the parser cannot build an AST. Whole-word matched.
 */
export const FORBIDDEN_KEYWORDS = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "create",
    "grant",
    "revoke",
    "comment",
    "call",
    "merge",
    "vacuum",
    "analyze",
    "copy",
    "lock",
    "reindex",
    "cluster",
    "refresh",
    "do",
    "execute",
    "prepare",
    "listen",
    "notify",
    "set",
    "reset",
] as const;

export class ReadOnlyViolationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReadOnlyViolationError";
    }
}

/**
 * Asserts that every parsed statement is a read-only SELECT.
 * Throws ReadOnlyViolationError on the first violation.
 */
export function assertStatementsReadOnly(statements: SqlStatement[]): void {
    for (const stmt of statements) {
        const type = (stmt.type ?? "").toLowerCase();

        if (type === "select") continue;

        const label = FORBIDDEN_STATEMENT_TYPES[type];
        if (label) {
            throw new ReadOnlyViolationError(
                `Query rejected: write operations are not allowed (${label}).`,
            );
        }

        // Unknown/unsupported statement type → reject conservatively.
        throw new ReadOnlyViolationError(
            "Query rejected: only read-only SELECT queries are allowed.",
        );
    }
}
