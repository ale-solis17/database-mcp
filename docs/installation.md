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
docker compose build database-mcp
```

Then start a session with the helper script, which names the container, removes
it on exit and passes `.env`:

**Linux / macOS**

```bash
./scripts/docker-mcp.sh run
```

**Windows (PowerShell)**

```bash
powershell -ExecutionPolicy Bypass -File .\scripts\docker-mcp.ps1 run
```

Equivalent raw commands:

```bash
docker run -i --rm --name database-mcp-session --env-file .env database-mcp:latest
```

### Do not use the Docker Desktop "Run"/"Start" button

This server speaks JSON-RPC over **stdio**: it needs a client holding its stdin
(`docker run -i`). The Docker Desktop buttons, and `docker compose up`, start the
container **without** stdin and **without** `.env` — so it fails with
`Missing required environment variable: DB_HOST`, or (with `--env-file`) refuses
to start because no client can ever talk to it. Both cases now print an
explanation and exit 1 instead of leaving a container running.

`env_file:` in `docker-compose.yml` is a Compose-only feature. Plain `docker run`
and the Desktop UI need `--env-file .env` passed explicitly.

### Container names and cleanup

`docker run` and `docker compose run` create a **new** container per invocation.
Without an explicit `--name` Docker invents one (`nervous_panini`), so sessions
pile up unidentifiable. Every container this project builds or starts carries the
label `com.database-mcp.stack=database-mcp` (baked into the image, so it applies
even when a client spawns the container), which makes them all trackable:

```bash
./scripts/docker-mcp.sh ps            # list every container of this project
./scripts/docker-mcp.sh clean         # remove the stopped ones
./scripts/docker-mcp.sh clean --force # remove running sessions too
```

The same actions exist on `scripts/docker-mcp.ps1` (`clean -Force`) and as
`npm run docker:ps`. Raw equivalent:

```bash
docker ps -a --filter label=com.database-mcp.stack=database-mcp
```

The server also exits as soon as its client closes stdin, so a session no longer
survives the client that spawned it.

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
| `Missing required environment variable: DB_HOST` | `.env` is missing or incomplete; in Docker, pass `--env-file .env` (the Desktop Run button does not) |
| `stdin is not connected to an MCP client`        | Started without stdin — use `docker run -i`, not the Desktop Run button or `compose up` |
| Random container names piling up in Docker Desktop | Use `scripts/docker-mcp.*`; list/clean with its `ps` / `clean` actions                |
| `Database connection failed`                     | Check host/port/credentials/SSL and network access                                     |
| SSL/certificate errors                           | Set `DB_SSL=true` (managed providers) or `false` (plain local)                         |
| `verify-permissions` exits with code 2           | The user has write privileges — create `mcp_readonly` (see [security.md](security.md)) |
| Client sees no output / protocol errors          | Ensure nothing writes to stdout; logs must go to stderr (already enforced)             |
