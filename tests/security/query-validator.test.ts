import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSelectQuery, QueryValidationError } from "../../src/security/query-validator.js";

function expectRejected(sql: string): void {
    assert.throws(() => validateSelectQuery(sql), QueryValidationError, `should reject: ${sql}`);
}

function expectAccepted(sql: string): void {
    assert.doesNotThrow(() => validateSelectQuery(sql), `should accept: ${sql}`);
}

describe("query-validator: accepts read-only SELECT", () => {
    it("simple select", () => expectAccepted("SELECT * FROM users"));
    it("select with where/limit", () =>
        expectAccepted("SELECT id, name FROM users WHERE id = 1 LIMIT 10"));
    it("select with trailing semicolon", () => expectAccepted("SELECT 1;"));
    it("CTE select", () => expectAccepted("WITH x AS (SELECT 1 AS n) SELECT * FROM x"));
    it("select with line comment", () => expectAccepted("SELECT 1 -- a comment\n"));
    it("select with pg cast and json op", () =>
        expectAccepted("SELECT id::text, data->>'k' FROM t"));
    it("join", () =>
        expectAccepted("SELECT a.id FROM a JOIN b ON b.a_id = a.id WHERE a.active"));
});

describe("query-validator: rejects writes and DDL", () => {
    it("INSERT", () => expectRejected("INSERT INTO t (a) VALUES (1)"));
    it("UPDATE", () => expectRejected("UPDATE t SET a = 1"));
    it("DELETE", () => expectRejected("DELETE FROM t"));
    it("DROP", () => expectRejected("DROP TABLE t"));
    it("ALTER", () => expectRejected("ALTER TABLE t ADD COLUMN c int"));
    it("TRUNCATE", () => expectRejected("TRUNCATE t"));
    it("CREATE", () => expectRejected("CREATE TABLE t (id int)"));
    it("GRANT", () => expectRejected("GRANT SELECT ON t TO r"));
    it("REVOKE", () => expectRejected("REVOKE SELECT ON t FROM r"));
    it("COMMENT", () => expectRejected("COMMENT ON TABLE t IS 'x'"));
});

describe("query-validator: rejects evasion attempts", () => {
    it("multiple statements", () => expectRejected("SELECT 1; SELECT 2"));
    it("select then drop", () => expectRejected("SELECT 1; DROP TABLE t"));
    it("comment-hidden second statement", () =>
        expectRejected("SELECT 1; /* hi */ DELETE FROM t"));
    it("data-modifying CTE", () =>
        expectRejected("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"));
    it("comment-only leading then write", () =>
        expectRejected("-- run this\nUPDATE t SET a = 1"));
    it("empty query", () => expectRejected(""));
    it("whitespace-only query", () => expectRejected("   \n  "));
});

describe("query-validator: rejects dangerous functions", () => {
    it("pg_sleep (DoS)", () => expectRejected("SELECT pg_sleep(10)"));
    it("pg_read_file (fs access)", () => expectRejected("SELECT pg_read_file('/etc/passwd')"));
    it("lo_import (large object)", () => expectRejected("SELECT lo_import('/etc/passwd')"));
    it("dblink (network)", () =>
        expectRejected("SELECT * FROM dblink('host=x', 'SELECT 1') AS t(a int)"));
    it("pg_terminate_backend (admin)", () => expectRejected("SELECT pg_terminate_backend(123)"));
    it("does not match a column named like a function", () =>
        expectAccepted("SELECT pg_sleepy FROM t"));
});

describe("query-validator: masking prevents false positives/negatives", () => {
    it("keyword inside a string literal is allowed", () =>
        expectAccepted("SELECT * FROM t WHERE note = 'please delete this later'"));
    it("function name inside a string literal is allowed", () =>
        expectAccepted("SELECT 'call pg_sleep(9)' AS hint FROM t"));
});
