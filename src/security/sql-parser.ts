import pkg from "node-sql-parser";

const { Parser } = pkg;

/**
 * Thin wrapper around node-sql-parser.
 *
 * The parser is used for STRUCTURAL analysis (statement type, statement count),
 * not as the sole security boundary. When parsing fails we fall back to a
 * conservative textual check, and the database itself enforces read-only
 * execution as the final guarantee (see PostgresAdapter.executeSelect).
 */

// node-sql-parser statement AST nodes carry a `type` field ("select", "insert", ...).
export interface SqlStatement {
    type?: string;
    [key: string]: unknown;
}

export interface ParseSuccess {
    ok: true;
    statements: SqlStatement[];
}

export interface ParseFailure {
    ok: false;
    error: string;
}

const parser = new Parser();
const PARSER_OPTS = { database: "postgresql" } as const;

/**
 * Removes SQL comments so they cannot be used to smuggle a second statement
 * or hide keywords past the textual fallback check.
 *
 * Handles `-- line` and `/* block *\/` comments while preserving string
 * literals (comment markers inside quotes are left untouched).
 */
export function stripComments(sql: string): string {
    let out = "";
    let i = 0;
    const n = sql.length;
    let quote: string | null = null; // active string/identifier quote char

    while (i < n) {
        const ch = sql[i]!;
        const next = i + 1 < n ? sql[i + 1] : "";

        if (quote) {
            out += ch;
            if (ch === quote) {
                // Handle doubled quote escape ('' or "").
                if (next === quote) {
                    out += next;
                    i += 2;
                    continue;
                }
                quote = null;
            }
            i += 1;
            continue;
        }

        if (ch === "'" || ch === '"') {
            quote = ch;
            out += ch;
            i += 1;
            continue;
        }

        if (ch === "-" && next === "-") {
            // Skip to end of line.
            i += 2;
            while (i < n && sql[i] !== "\n") i += 1;
            continue;
        }

        if (ch === "/" && next === "*") {
            // Skip to closing */.
            i += 2;
            while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
            i += 2;
            out += " "; // preserve token separation
            continue;
        }

        out += ch;
        i += 1;
    }

    return out;
}

/**
 * Splits on top-level semicolons (ignoring those inside string/identifier
 * quotes), returning the non-empty trimmed statements. Used to detect multiple
 * statements even when the parser accepts the input.
 */
export function splitStatements(sql: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;

    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i]!;
        if (quote) {
            current += ch;
            if (ch === quote) {
                if (sql[i + 1] === quote) {
                    current += sql[i + 1];
                    i += 1;
                } else {
                    quote = null;
                }
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ";") {
            if (current.trim()) parts.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/**
 * Replaces the contents of string/identifier literals with blanks so textual
 * scans (keyword / dangerous-function checks) cannot be fooled by keywords that
 * merely appear inside a quoted value. Quote characters are preserved.
 */
export function maskStringLiterals(sql: string): string {
    let out = "";
    let quote: string | null = null;
    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i]!;
        if (quote) {
            if (ch === quote) {
                if (sql[i + 1] === quote) {
                    out += "  ";
                    i += 1;
                    continue;
                }
                quote = null;
                out += ch;
            } else {
                out += " ";
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            out += ch;
            continue;
        }
        out += ch;
    }
    return out;
}

export function parse(sql: string): ParseSuccess | ParseFailure {
    try {
        const ast = parser.astify(sql, PARSER_OPTS);
        const statements = (Array.isArray(ast) ? ast : [ast]) as unknown as SqlStatement[];
        return { ok: true, statements };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
