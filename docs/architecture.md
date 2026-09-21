# Architecture

## Goals

- **Generic and reusable** — no project/company/business-specific logic.
- **Decoupled** — the MCP layer does not know about any specific engine, and adapters do not know about MCP.
- **Read-only and safe** — see [security.md](security.md).
- **Extensible** — new engines slot in behind one interface.

## Layers

```
src/
├── index.ts                # entrypoint: load profiles → registry → server → stdio
├── logger.ts               # stderr-only structured logger
├── healthcheck.ts          # standalone DB connectivity check (Docker HEALTHCHECK)
├── verify-permissions.ts   # standalone read-only privilege check
│
├── cli-args.ts             # --profile / --all parsing for the scripts above
│
├── config/
│   ├── paths.ts            # cwd-independent file locations
│   ├── load-env-file.ts    # loads .env once, from the package root
│   ├── env.ts              # typed, validated global settings
│   ├── databases.ts        # loads + validates databases.json (the profiles)
│   └── database-config.ts  # builds QueryLimits
│
├── types/                  # engine-agnostic shared types
│   ├── database.types.ts
│   └── mcp.types.ts
│
├── mcp/                    # MCP layer — no engine-specific code
│   ├── server.ts           # createMcpServer(context)
│   └── tools/              # one file per tool + registry (index.ts)
│
├── database/               # data access
│   ├── database.adapter.ts    # the DatabaseAdapter interface (the contract)
│   ├── connection-registry.ts # profile name → adapter (lazy)
│   └── postgres/
│       └── postgres.adapter.ts
│
└── security/               # query validation (see security.md)
    ├── query-validator.ts
    ├── sql-parser.ts
    ├── permission-checker.ts
    └── dangerous-functions.ts
```

## Dependency direction

```
tools  ──▶  ConnectionRegistry  ──▶  DatabaseAdapter (interface)  ◀── PostgresAdapter
  │
  └──▶  security/query-validator (for execute_select only)
```

- **Tools** receive a `ToolContext` (`{ registry, limits }`) via dependency injection. They resolve an adapter for the requested profile and never construct engine objects or write SQL.
- **`execute_select`** calls the validator (layer 1), then the adapter (which enforces layers 2).
- **Adapters** translate the abstract interface into engine-specific SQL and map results into the shared `types/`.
- **Config** is isolated; nothing else touches `process.env`. The one documented exception is the `${VAR}` interpolator in `databases.ts`, which resolves arbitrary user-named variables by design and takes the environment by injection.

## Request flow (execute_select)

```
client → execute_select tool
       → validateSelectQuery()      (reject non-read-only / dangerous)
       → adapter.executeSelect()     (READ ONLY tx + timeout + row cap + size cap)
       → structured QueryResultData → client
```

## Multiple databases (profiles)

One server process serves several databases. Each is a named **profile** in
`databases.json`:

```json
{
  "defaultProfile": "production",
  "profiles": {
    "production": { "host": "...", "database": "...", "user": "...", "password": "${VAR}" },
    "analytics":  { "url": "${ANALYTICS_URL}" }
  }
}
```

- `config/databases.ts` loads, interpolates (`${VAR}` from `.env`) and validates
  the file, producing one `DatabaseConfig` per profile.
- `database/connection-registry.ts` maps a profile name to a `DatabaseAdapter`,
  creating it on first use.
- The registry is injected into the `ToolContext`; every tool takes an optional
  `profile` argument and resolves an adapter through `resolveAdapter()`.
- `list_databases` exposes the profile list to the model.

The `DatabaseAdapter` interface is unchanged by this: each instance is still
bound to exactly one database.

**Adapters are constructed lazily and are not connectivity-checked at startup**
(only the default profile is probed, as a warning). Opening every pool up front
would make an MCP client wait on N round-trips at spawn time, and one
unreachable database would take down access to all the healthy ones. Instead a
connection failure surfaces on the tool call that touched that profile, so the
model can simply use another database — and `list_databases` reports which one
is broken.

## Why these choices

- **`node:test` + `tsx`** — zero extra test dependencies on Node 20+.
- **`node-sql-parser`** — a real parser (pure JS, cross-platform) instead of fragile `includes()`/regex checks.
- **READ ONLY transaction** — the strongest, engine-enforced guarantee, independent of parsing correctness.
- **stderr-only logging** — required because MCP uses stdout for its JSON-RPC stream.
