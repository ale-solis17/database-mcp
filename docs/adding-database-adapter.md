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

In [`src/index.ts`](../src/index.ts), extend the switch:

```ts
switch (dbConfig.type) {
    case "postgres": adapter = new PostgresAdapter(dbConfig); break;
    case "mysql":    adapter = new MySQLAdapter(dbConfig);    break;   // new
    default: throw new Error(`No adapter available for DB_TYPE "${dbConfig.type}"`);
}
```

Add the engine to the `DatabaseType` union in
`src/types/database.types.ts` and to `SUPPORTED_TYPES` in
`src/config/database-config.ts`.

## 4. If the SQL dialect differs

`query-validator` uses `node-sql-parser` configured for PostgreSQL. For a
different dialect, thread the dialect through `sql-parser.ts` (node-sql-parser
supports `mysql`, `transactsql`, etc.). The read-only transaction in the adapter
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
- [ ] Registered in `index.ts`, `DatabaseType`, `SUPPORTED_TYPES`
- [ ] Results mapped into existing shared types
- [ ] Tests added (self-skipping integration)
