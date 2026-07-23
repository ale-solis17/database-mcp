# Architecture

## Goals

- **Generic and reusable** — no project/company/business-specific logic.
- **Decoupled** — the MCP layer does not know about any specific engine, and adapters do not know about MCP.
- **Read-only and safe** — see [security.md](security.md).
- **Extensible** — new engines slot in behind one interface.

## Layers

```
src/
├── index.ts                # entrypoint: build config → adapter → server → stdio
├── logger.ts               # stderr-only structured logger
├── healthcheck.ts          # standalone DB connectivity check (Docker HEALTHCHECK)
├── verify-permissions.ts   # standalone read-only privilege check
│
├── config/                 # the ONLY place that reads process.env
│   ├── env.ts              # typed, validated environment
│   └── database-config.ts  # builds DatabaseConfig + QueryLimits
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
│   ├── database.adapter.ts # the DatabaseAdapter interface (the contract)
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
tools  ──▶  DatabaseAdapter (interface)  ◀── PostgresAdapter
  │
  └──▶  security/query-validator (for execute_select only)
```

- **Tools** receive a `ToolContext` (`{ adapter, limits }`) via dependency injection. They never construct engine objects or write SQL.
- **`execute_select`** calls the validator (layer 1), then the adapter (which enforces layers 2).
- **Adapters** translate the abstract interface into engine-specific SQL and map results into the shared `types/`.
- **Config** is isolated; nothing else touches `process.env`.

## Request flow (execute_select)

```
client → execute_select tool
       → validateSelectQuery()      (reject non-read-only / dangerous)
       → adapter.executeSelect()     (READ ONLY tx + timeout + row cap + size cap)
       → structured QueryResultData → client
```

## Multi-connection (future)

The current server binds one adapter to one database. The design keeps the door open for named connections:

```
connections:
  production:  { type, host, port, database, credentials }
  staging:     { ... }
  analytics:   { ... }
```

To add this without rewriting the core: introduce a connection registry (name → adapter), inject the registry into the `ToolContext`, and add an optional `connection` argument to tools that resolves to an adapter. The interface and tools stay the same.

## Why these choices

- **`node:test` + `tsx`** — zero extra test dependencies on Node 20+.
- **`node-sql-parser`** — a real parser (pure JS, cross-platform) instead of fragile `includes()`/regex checks.
- **READ ONLY transaction** — the strongest, engine-enforced guarantee, independent of parsing correctness.
- **stderr-only logging** — required because MCP uses stdout for its JSON-RPC stream.
