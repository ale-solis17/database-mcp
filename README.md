# Database MCP Server

A **generic, reusable, read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants (e.g. Claude Code) safely **inspect and query** a database. PostgreSQL is supported today; the architecture is ready for MySQL and SQL Server.

It is designed as an independent product — not tied to any specific project, company or business logic — so it can be pointed at any compatible database: SaaS backends, legacy systems, schema reviews, debugging, query generation and general development assistance.

> **Read-only by design.** The server only ever reads. Writes, DDL and DCL are blocked at three independent layers (see [Security](#security)).

---

## Table of contents

1. [What it is](#what-it-is)
2. [Architecture](#architecture)
3. [Requirements](#requirements)
4. [Quick install](#quick-install)
5. [Docker install](#docker-install)
6. [Configuration (.env)](#configuration-env)
7. [Creating the read-only PostgreSQL user](#creating-the-read-only-postgresql-user)
8. [Connecting Claude Code](#connecting-claude-code)
9. [Other MCP clients](#other-mcp-clients)
10. [Available tools](#available-tools)
11. [Security](#security)
12. [Limitations](#limitations)
13. [Local development](#local-development)
14. [Tests](#tests)
15. [Build](#build)
16. [Docker details](#docker-details)
17. [Adding a new database engine](#adding-a-new-database-engine)

---

## What it is

The server exposes a set of MCP **tools** an AI can call to understand and query a database without being able to change it:

- Discover the structure: schemas, tables, columns, types, keys, indexes, comments.
- Read relationships (foreign keys) between tables.
- Reconstruct table DDL.
- List and read views and stored functions/procedures (inspection only — never executed).
- Run **read-only `SELECT`** queries with row, timeout and size limits.
- Get a compact, high-level overview of the whole database in a single call.

The AI **cannot** `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE`, `COMMENT`, or otherwise modify data or structure.

## Architecture

```
MCP client (Claude Code, …)
        │  JSON-RPC over stdio
        ▼
┌─────────────────────────────┐
│ MCP layer (src/mcp)          │  tools/*.tool.ts — engine-agnostic
│  registers tools, DI context │
└───────────────┬─────────────┘
                │ calls
        ┌────────▼─────────┐        ┌───────────────────────────┐
        │ DatabaseAdapter   │        │ Security (src/security)   │
        │ (interface)       │        │  query-validator          │
        └────────┬─────────┘        │  sql-parser                │
                 │ implements       │  permission-checker        │
        ┌────────▼─────────┐        │  dangerous-functions       │
        │ PostgresAdapter   │        └───────────────────────────┘
        │ (MySQL/SQLServer  │
        │  in the future)   │
        └───────────────────┘
```

Key rule: **the MCP layer knows nothing about PostgreSQL**, and **adapters know nothing about MCP**. See [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js **20+**
- A reachable PostgreSQL database
- (Optional) Docker + Docker Compose

## Quick install

The interactive setup script does everything: collects credentials, writes `.env`, builds, validates the connection, checks read-only permissions and prints the MCP client config.

**Linux / macOS**

```bash
./setup.sh
```

**Windows (PowerShell)**

```bash
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Manual alternative:

```bash
cp .env.example .env   # then edit values
npm install
npm run build
npm run healthcheck          # validates the connection
npm run verify-permissions   # checks the user is read-only
```

## Docker install

```bash
cp .env.example .env   # edit values
docker compose build
docker compose run --rm database-mcp
```

See [Docker details](#docker-details) and [docs/installation.md](docs/installation.md).

## Configuration (.env)

Copy [.env.example](.env.example) to `.env` and fill it in. **Never commit `.env`.**

| Variable             | Default        | Description                                      |
|----------------------|----------------|--------------------------------------------------|
| `DB_TYPE`            | `postgres`     | Engine (only `postgres` implemented)             |
| `DB_HOST`            | —              | Database host                                    |
| `DB_PORT`            | `5432`         | Database port                                    |
| `DB_NAME`            | —              | Database name                                    |
| `DB_USER`            | —              | **Read-only** user (see below)                   |
| `DB_PASSWORD`        | —              | Password                                         |
| `DB_SSL`             | auto           | `true`/`false`; auto-enabled for non-local hosts |
| `MCP_NAME`           | `database-mcp` | Server name reported to clients                  |
| `MCP_VERSION`        | `1.0.0`        | Server version                                   |
| `MAX_ROWS`           | `1000`         | Max rows returned per query                      |
| `QUERY_TIMEOUT_MS`   | `10000`        | Per-query timeout                                |
| `MAX_RESULT_SIZE_MB` | `10`           | Max serialized result size                       |
| `LOG_LEVEL`          | `info`         | `debug`/`info`/`warn`/`error`                    |

## Creating the read-only PostgreSQL user

**Do not use your application or owner user.** Create a dedicated role. The full script is in [sql/create_readonly_user.sql](sql/create_readonly_user.sql):

```sql
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change_me_strong_password';
GRANT CONNECT ON DATABASE your_database TO mcp_readonly;
-- PostgreSQL 14+: SELECT on every table/view in every schema (current & future),
-- no per-schema/per-tenant grants needed.
GRANT pg_read_all_data TO mcp_readonly;
-- Force every transaction from this role to be read-only.
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;
```

> For PostgreSQL < 14 (no `pg_read_all_data`), grant per schema instead — see [sql/create_readonly_user.sql](sql/create_readonly_user.sql).

Verify it: `npm run verify-permissions`. Details in [docs/security.md](docs/security.md).

## Connecting an MCP client

> **Important:** the MCP client config always lives on the **user's machine**, not
> inside this repo — it contains absolute paths and secrets, which differ per
> person. You never commit it. What *is* shareable is this project plus the
> generator below, which produces the correct config for whoever runs it.

### The easy way — generate it

```bash
npm run generate-config           # prints the snippet for THIS machine (Node + Docker variants)
npm run generate-config -- --merge          # writes it into your Claude Desktop config automatically
npm run generate-config -- --merge --docker  # same, but using the Docker command
```

The generator fills in this machine's absolute Node path, the absolute path to
`dist/index.js`, and the values from your local `.env`. It knows the Claude
Desktop config location on Windows, macOS and Linux. `--merge` backs up any
existing config and only adds/updates the `database-mcp` entry (it never
touches your other servers). The interactive `setup` scripts run this for you.

### Claude Code (CLI, if installed)

```bash
claude mcp add database-mcp -- node "/absolute/path/to/dist/index.js"
```

### Manual (any MCP client, e.g. Claude Desktop)

Add under `mcpServers` in the client's config file. **Node variant** — put your
real values in `env` so it doesn't depend on a `.env` file or working directory:

```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "DB_TYPE": "postgres",
        "DB_HOST": "your-host",
        "DB_PORT": "5432",
        "DB_NAME": "your_db",
        "DB_USER": "mcp_readonly",
        "DB_PASSWORD": "your_password",
        "DB_SSL": "true"
      }
    }
  }
}
```

**Docker variant** — portable across machines (same image name everywhere); only
the `.env` path is machine-specific:

```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--env-file", "/absolute/path/.env", "database-mcp:latest"]
    }
  }
}
```

After editing the config, **fully restart the client** (for Claude Desktop, Quit
from the tray — closing the window is not enough).

### Sharing the project with someone else

The project is generic; only per-machine details differ. Each person:

1. Gets the code (clone/copy **without** `node_modules`, `dist`, `.env`).
2. Runs `./setup.sh` / `setup.ps1` (or `npm install && npm run build`) — this
   builds it **and** generates their config snippet with their own paths.
3. Creates their own `.env` (their database, their `mcp_readonly` user), or lets
   the setup script collect it.
4. Restarts their MCP client.

Nobody edits paths by hand, and no secrets travel with the repo.

## Available tools

| Tool                       | Description                                                       |
|----------------------------|-------------------------------------------------------------------|
| `list_schemas`             | List user-visible schemas (system schemas excluded)               |
| `list_tables`              | List tables (optionally by schema)                                |
| `describe_table`           | Columns, types, nullability, defaults, PK, FKs, indexes, comments |
| `execute_select`           | Run a **read-only** `SELECT`/`WITH` query (validated + capped)    |
| `get_table_ddl`            | Reconstructed `CREATE TABLE` DDL incl. indexes & comments         |
| `get_relationships`        | Foreign-key relationships between tables                          |
| `list_views`               | Views and materialized views                                      |
| `get_view_definition`      | SQL definition of a view                                          |
| `list_procedures`          | Stored functions and procedures (distinguished)                   |
| `get_procedure_definition` | Source of a function/procedure (inspection only)                  |
| `get_database_overview`    | Compact, single-call snapshot of the whole database               |

## Security

Three independent layers — see [docs/security.md](docs/security.md) for the full model.

1. **SQL validation (MCP layer).** Every `execute_select` query is parsed with a real SQL parser ([node-sql-parser](https://www.npmjs.com/package/node-sql-parser)). Only a **single** `SELECT`/`WITH`-select statement is allowed. Rejected: writes, DDL, DCL, multiple statements, comment-smuggled statements, data-modifying CTEs, and a denylist of dangerous functions (`pg_sleep`, `pg_read_file`, `lo_*`, `dblink`, admin functions…). String literals are masked so keywords/functions inside quotes can't fool or trip the checks. A textual fallback guards queries the parser can't build an AST for.
2. **Read-only transaction (engine).** Queries run inside `BEGIN TRANSACTION READ ONLY` with `SET LOCAL statement_timeout`. PostgreSQL itself refuses any write — the strongest guarantee, independent of parsing.
3. **Read-only database user (last line).** The dedicated `mcp_readonly` role has no write privileges, so even a bug upstream cannot modify data.

**Privilege-aware discovery.** The listing tools (`list_schemas`, `list_tables`, `list_views`, `list_procedures`, `get_relationships`, `get_database_overview`) only surface schemas/objects the **connected user can actually access** (`has_schema_privilege` / `has_table_privilege`). So "what the AI sees" always matches "what it can query" — no listing tables that `execute_select` would then reject. Targeted inspection tools (`describe_table`, `get_table_ddl`, `get_view_definition`, `get_procedure_definition`) read the system catalog for a named object, so they work regardless of grants.

Plus: row cap (`MAX_ROWS`), query timeout (`QUERY_TIMEOUT_MS`), result-size cap (`MAX_RESULT_SIZE_MB`), safe error messages (no credentials/connection strings leaked), and logs written to **stderr only** (stdout is reserved for the MCP protocol).

## Limitations

- Only PostgreSQL is implemented (MySQL/SQL Server are architecturally prepared, not built).
- `execute_select` wraps queries as `SELECT * FROM (<query>) LIMIT n`; a query whose output has **duplicate column names** will error (add explicit aliases).
- The dangerous-function denylist is best-effort defense-in-depth; the read-only transaction and read-only user are the hard guarantees.
- Single connection/database per server instance (multi-connection is a planned evolution — see [docs/architecture.md](docs/architecture.md)).

## Local development

```bash
npm install
npm run dev          # runs src/index.ts with tsx (no build)
npm run typecheck    # tsc --noEmit
```

## Tests

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) with `tsx`. Security tests run without a database. The integration tests in `tests/database/` auto-skip if no database is reachable, so CI without a database still passes. See [docs/installation.md](docs/installation.md) for running against a throwaway PostgreSQL via the `local-db` Compose profile.

## Build

```bash
npm run build        # tsc -> dist/
npm start            # node dist/index.js
```

## Docker details

- Multi-stage [Dockerfile](Dockerfile): builds TypeScript, then ships only production deps.
- Runs as the non-root `node` user.
- `HEALTHCHECK` runs `dist/healthcheck.js` to verify DB connectivity.
- [docker-compose.yml](docker-compose.yml) reads `.env`, uses a bridge network, and offers an optional bundled PostgreSQL under the `local-db` profile:

```bash
docker compose --profile local-db up -d postgres
```

## Adding a new database engine

Implement the `DatabaseAdapter` interface for the new engine and register it in `src/index.ts`. No changes to the MCP tools are needed. Step-by-step guide: [docs/adding-database-adapter.md](docs/adding-database-adapter.md).
