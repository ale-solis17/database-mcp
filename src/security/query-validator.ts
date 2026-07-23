import { maskStringLiterals, parse, splitStatements, stripComments } from "./sql-parser.js";
import { assertStatementsReadOnly, ReadOnlyViolationError } from "./permission-checker.js";
import { assertNoDangerousFunctions, DangerousFunctionError } from "./dangerous-functions.js";

/**
 * Central read-only query validator.
 *
 * Layered defense (this module is layers A + the pre-check for B):
 *   A. Structural validation via SQL parser (statement type + count).
 *   B. Textual fallback when the parser cannot build an AST.
 *   (C. The adapter executes inside a `READ ONLY` transaction — the hard,
 *       engine-enforced guarantee. See PostgresAdapter.executeSelect.)
 */

export class QueryValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "QueryValidationError";
    }
}

/** Upper bound on query length to blunt pathological / abusive inputs. */
const MAX_QUERY_LENGTH = 50_000;

/**
 * Hard write/DDL/DCL keywords the textual fallback rejects anywhere in the
 * statement. Deliberately excludes ambiguous words (e.g. "set", "analyze")
 * that legitimately appear in SELECTs; the READ ONLY transaction covers those.
 */
const FALLBACK_FORBIDDEN = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "create",
    "grant",
    "revoke",
    "merge",
    "copy",
    "call",
    "vacuum",
    "reindex",
    "cluster",
    "refresh",
    "comment",
];

/**
 * Validates that `sql` is a single read-only SELECT statement.
 * Returns the cleaned query (trailing semicolon removed) or throws
 * QueryValidationError with a safe, AI-friendly message.
 */
export function validateSelectQuery(sql: string): string {
    if (typeof sql !== "string" || sql.trim() === "") {
        throw new QueryValidationError("Query rejected: empty query.");
    }
    if (sql.length > MAX_QUERY_LENGTH) {
        throw new QueryValidationError(
            `Query rejected: query exceeds the maximum length of ${MAX_QUERY_LENGTH} characters.`,
        );
    }

    // Strip comments first so they cannot hide a second statement or keyword.
    const stripped = stripComments(sql).trim();
    if (stripped === "") {
        throw new QueryValidationError("Query rejected: empty query.");
    }

    // Reject multiple statements up front (belt-and-suspenders with the parser).
    const parts = splitStatements(stripped);
    if (parts.length > 1) {
        throw new QueryValidationError(
            "Query rejected: multiple SQL statements are not allowed.",
        );
    }

    const single = parts[0] ?? stripped;

    // String literals are masked so keyword / function scans can't be fooled by
    // values inside quotes (e.g. WHERE note = 'please DELETE later').
    const masked = maskStringLiterals(single);

    // Restricted-function denylist applies regardless of parse success.
    try {
        assertNoDangerousFunctions(masked);
    } catch (err) {
        if (err instanceof DangerousFunctionError) {
            throw new QueryValidationError(err.message);
        }
        throw err;
    }

    const parsed = parse(single);

    if (parsed.ok) {
        if (parsed.statements.length !== 1) {
            throw new QueryValidationError(
                "Query rejected: multiple SQL statements are not allowed.",
            );
        }
        // Normalize the read-only violation into the validator's error type.
        try {
            assertStatementsReadOnly(parsed.statements);
        } catch (err) {
            if (err instanceof ReadOnlyViolationError) {
                throw new QueryValidationError(err.message);
            }
            throw err;
        }
        return single;
    }

    // ── Textual fallback (parser could not build an AST) ──────────────────
    const lowered = masked.toLowerCase();
    const leading = lowered.match(/^[a-z]+/)?.[0] ?? "";
    if (leading !== "select" && leading !== "with") {
        throw new QueryValidationError(
            "Query rejected: only read-only SELECT queries are allowed.",
        );
    }
    for (const kw of FALLBACK_FORBIDDEN) {
        if (new RegExp(`\\b${kw}\\b`, "i").test(lowered)) {
            throw new QueryValidationError(
                `Query rejected: write operations are not allowed (${kw.toUpperCase()}).`,
            );
        }
    }
    return single;
}
