# Security model

The server is read-only **by design**, enforced at three independent layers. A failure in one layer is contained by the others (defense in depth).

## Layer 1 — SQL validation (MCP layer)

Implemented in `src/security/`:

- **`sql-parser.ts`** — wraps [node-sql-parser](https://www.npmjs.com/package/node-sql-parser) (PostgreSQL dialect). Also provides `stripComments`, `splitStatements` and `maskStringLiterals`, all of which respect quoted strings.
- **`permission-checker.ts`** — the only allowed statement type is `select` (which covers `WITH … SELECT`). Everything else (`insert`, `update`, `delete`, `drop`, `alter`, `truncate`, `create`, `grant`, `revoke`, `comment`, `call`, …) is rejected.
- **`dangerous-functions.ts`** — denylist of functions that are read-only at the transaction level but still dangerous: DoS (`pg_sleep`), server filesystem access (`pg_read_file`, `pg_ls_dir`), large-object I/O (`lo_import`/`lo_export`), network (`dblink`), and session/admin control (`pg_terminate_backend`, `pg_reload_conf`, …).
- **`query-validator.ts`** — orchestrates the above.

What is rejected, with clear messages:

- Any write / DDL / DCL statement.
- **Multiple statements** (`SELECT 1; DROP TABLE t`).
- **Comment-smuggled** statements (`SELECT 1; /* x */ DELETE …`).
- **Data-modifying CTEs** (`WITH d AS (DELETE … RETURNING *) SELECT …`).
- **Dangerous functions** anywhere in the query.
- Over-long queries.

String literals are masked before textual scans, so a value like `WHERE note = 'please delete later'` is **not** a false positive, and `SELECT 'pg_sleep(9)'` is not blocked, while a real `pg_sleep(9)` call is.

## Layer 2 — Read-only transaction (engine)

Every query executes as:

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = <QUERY_TIMEOUT_MS>;
SELECT * FROM (<your query>) AS _mcp_sub LIMIT <MAX_ROWS + 1>;
ROLLBACK;
```

PostgreSQL itself raises `cannot execute … in a read-only transaction` for any write attempt. This holds **even if layer 1 were bypassed**, and does not depend on parsing being perfect.

Also enforced here: **row cap** (`MAX_ROWS`), **timeout** (`QUERY_TIMEOUT_MS`), and **result-size cap** (`MAX_RESULT_SIZE_MB`).

## Layer 3 — Read-only database user (last line)

The MCP must connect with a dedicated role that has no write privileges. Even a bug in layers 1–2 cannot modify data.

Create it (full script: [`sql/create_readonly_user.sql`](../sql/create_readonly_user.sql)):

```sql
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change_me_strong_password';
GRANT CONNECT ON DATABASE your_database TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;  -- PG 14+
```

Repeat the schema block for each schema you expose. No `EXECUTE` grants are needed — the MCP only inspects function/procedure definitions, it never calls them.

Verify with:

```bash
npm run verify-permissions
```

Exit code `0` = looks read-only, `2` = has write capability (fix it), `1` = could not connect.

## Other safeguards

- **Errors are sanitized** — no passwords or connection strings are ever included.
- **Logs go to stderr only** — stdout is reserved for the MCP protocol; logs never leak into it.
- **Query text logging** is intentionally minimal to avoid recording sensitive data.
- **Credentials** live only in `.env` / environment variables, never in source or the Docker image.

## Reporting

If you find a way to make the server perform a write, treat it as a security issue and report it privately to the maintainers before disclosing.
