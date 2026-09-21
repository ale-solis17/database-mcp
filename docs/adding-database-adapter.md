# Adding a new database engine

The MCP tools are engine-agnostic: they depend only on the `DatabaseAdapter`
interface. Adding MySQL, SQL Server, etc. means implementing that interface —
**no tool or MCP code changes are required**.

## 1. Implement the interface

Create `src/database/<engine>/<engine>.adapter.ts` implementing every method of
[`DatabaseAdapter`](../src/database/database.adapter.ts):

```ts
import type { DatabaseAdapter } from "../database.adapter.js";
import type { DatabaseConfig /* … */ } from "../../types/database.types.js";

export class MySQLAdapter implements DatabaseAdapter {
    constructor(private readonly dbConfig: DatabaseConfig) { /* create pool */ }

    async testConnection(): Promise<boolean> { /* … */ }
    async executeSelect(query, limits) { /* READ-ONLY execution + limits */ }
    async listSchemas() { /* … */ }
    async listTables(schema?) { /* … */ }
    async describeTable(schema, table) { /* … */ }
    async getTableDDL(schema, table) { /* … */ }
    async getRelationships(schema?) { /* … */ }
    async listViews(schema?) { /* … */ }
    async getViewDefinition(schema, view) { /* … */ }
    async listProcedures(schema?) { /* … */ }
    async getProcedureDefinition(schema, name) { /* … */ }
    async getDatabaseOverview() { /* … */ }
    async close() { /* end pool */ }
}
```

Map the engine's native metadata (its `information_schema` / system catalogs)
into the shared types in `src/types/database.types.ts`. Do not invent new return
shapes — the tools rely on the existing ones.

## 2. Enforce read-only execution in the adapter

Layer 1 (the SQL validator) is engine-independent and already runs before the
adapter. But **each adapter must also enforce read-only execution at the engine
level** (layer 2), the same way `PostgresAdapter` uses a `READ ONLY`
transaction. Engine equivalents:

| Engine | Read-only mechanism |
|--------|---------------------|
| PostgreSQL | `BEGIN TRANSACTION READ ONLY` + `SET LOCAL statement_timeout` |
| MySQL | `START TRANSACTION READ ONLY` + `SET SESSION max_execution_time` |
| SQL Server | read-only connection intent / `SET TRANSACTION ISOLATION` + query governor; run under a read-only login |

Always apply the row cap, timeout and result-size cap from `QueryLimits`.

## 3. Register the adapter

Adapters are built per profile by the connection registry. In
[`src/database/connection-registry.ts`](../src/database/connection-registry.ts),
extend the construction to cover the new engine, keyed off the profile's
`type` field:

```ts
switch (config.config.type) {
    case "postgres": return new PostgresAdapter(config.config);
    case "mysql":    return new MySQLAdapter(config.config);    // new
}
```

Add the engine to the `DatabaseType` union in
`src/types/database.types.ts`, and to `IMPLEMENTED_TYPES` in
`src/config/databases.ts` (`SUPPORTED_TYPES` there already lists the names the
config file accepts).

Unimplemented engines fail when the adapter is constructed rather than when the
config is parsed, so a `databases.json` containing a future `mysql` profile
still lets the PostgreSQL ones work.

## 4. If the SQL dialect differs

`query-validator` uses `node-sql-parser` configured for PostgreSQL, fixed at
`sql-parser.ts` (`PARSER_OPTS`). For a different dialect, thread the dialect
through from the profile's `type` (node-sql-parser supports `mysql`,
`transactsql`, etc.) — with profiles this becomes per-call, not global. The read-only transaction in the adapter
remains the hard guarantee regardless.

## 5. Test it

- Add unit coverage for any dialect-specific validation.
- Add an integration suite under `tests/database/` mirroring
  `postgres.adapter.test.ts` (row cap, timeout, read-only block). Keep it
  self-skipping when no database is reachable.

## Checklist

- [ ] Adapter implements all `DatabaseAdapter` methods
- [ ] Read-only execution enforced at the engine level
- [ ] Row / timeout / size limits applied
- [ ] System schemas excluded from listings
- [ ] Registered in `connection-registry.ts`, `DatabaseType`, `IMPLEMENTED_TYPES`
- [ ] Results mapped into existing shared types
- [ ] Tests added (self-skipping integration)
