# Installation

## Prerequisites

- Node.js 20+
- A reachable PostgreSQL database
- (Optional) Docker + Docker Compose

## Option A — Interactive setup (recommended)

**Linux / macOS**

```bash
./setup.sh
```

**Windows (PowerShell)**

```bash
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The script will:

1. Detect Node.js (and Docker, if present).
2. Prompt for `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL` (password entry is hidden).
3. Write `.env` (backing up any existing one).
4. `npm install` and `npm run build`.
5. Validate the connection (`healthcheck`).
6. Verify the user is read-only (`verify-permissions`).
7. Print the exact command/config to connect an MCP client.

Passwords are never stored anywhere except your local `.env`.

## Option B — Manual

```bash
cp .env.example .env      # edit values
npm install
npm run build
npm run healthcheck
npm run verify-permissions
```

## Option C — Docker

```bash
cp .env.example .env      # edit values
docker compose build
docker compose run --rm database-mcp
```

## Testing against a throwaway PostgreSQL

A local PostgreSQL is bundled in `docker-compose.yml` under the `local-db` profile:

```bash
docker compose --profile local-db up -d postgres
# point .env at:  DB_HOST=localhost  DB_PORT=5432  DB_USER=postgres  DB_PASSWORD=postgres  DB_NAME=postgres
```

Then create some tables and run `npm test` (the integration suite will use the configured connection).

## Troubleshooting

| Symptom                                          | Fix                                                                                    |
|--------------------------------------------------|----------------------------------------------------------------------------------------|
| `Missing required environment variable: DB_HOST` | `.env` is missing or incomplete                                                        |
| `Database connection failed`                     | Check host/port/credentials/SSL and network access                                     |
| SSL/certificate errors                           | Set `DB_SSL=true` (managed providers) or `false` (plain local)                         |
| `verify-permissions` exits with code 2           | The user has write privileges — create `mcp_readonly` (see [security.md](security.md)) |
| Client sees no output / protocol errors          | Ensure nothing writes to stdout; logs must go to stderr (already enforced)             |
