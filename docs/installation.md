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
2. `npm install` and `npm run build` — **before** any prompting, because each
   database is verified as you enter it and that needs the build.
3. Ask for each database in turn: a name, then either a pasted connection URL
   or the fields one by one (password entry is hidden), then a description.
4. Verify that database's connection and read-only permissions immediately.
   If the user is not read-only it offers to generate a ready-to-run
   `sql/generated/<profile>.create_readonly_user.sql`.
5. Ask "Add another database?" and loop, then ask which profile is the default.
6. Write `databases.json` and merge the secrets into `.env`.
7. Print the exact command/config to connect an MCP client.

Passwords are never written into `databases.json` — it gets `${VAR}`
references, and the values go in your local `.env`.

Re-running setup on an existing `databases.json` offers to add a database, edit
one, change the default, start over (with a backup), or just regenerate the
client config.

## Option B — Manual

```bash
cp .env.example .env                       # global settings + ${VAR} secrets
cp databases.example.json databases.json   # one entry per database
npm install
npm run build
npm run healthcheck -- --all     # every profile's connection
npm run verify-permissions       # every profile's read-only audit
```

## Option C — Docker

```bash
cp .env.example .env                       # global settings + ${VAR} secrets
cp databases.example.json databases.json   # one entry per database
docker compose build database-mcp
```

Then start a session with the helper script, which names the container, removes
it on exit, passes `.env` and mounts `databases.json` read-only:

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
docker run -i --rm --name database-mcp-session   --env-file .env   -v "$PWD/databases.json:/config/databases.json:ro"   -e DATABASES_CONFIG=/config/databases.json   database-mcp:latest
```

`databases.json` is **mounted**, never baked into the image: it holds `${VAR}`
references rather than values, so nothing confidential ends up in a layer.

### Do not use the Docker Desktop "Run"/"Start" button

This server speaks JSON-RPC over **stdio**: it needs a client holding its stdin
(`docker run -i`). The Docker Desktop buttons, and `docker compose up`, start the
container **without** stdin and **without** `.env` — so it fails with
`Configuration not found: databases.json`, or (with `--env-file`) refuses
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

A local PostgreSQL is bundled in `docker-compose.yml`:

```bash
npm run local-db:up      # start it
npm run local-db:down    # stop it
```

Then add a profile for it in `databases.json`:

```json
"throwaway": {
  "host": "localhost",
  "port": 5432,
  "database": "postgres",
  "user": "postgres",
  "password": "${MCPDB_THROWAWAY_PASSWORD}",
  "ssl": false
}
```

> The npm scripts wrap `docker compose --profile local-db`. That `--profile` is
> a **Docker Compose** feature and is unrelated to this project's **database
> profiles** — the scripts exist so you never have to type it.

Then create some tables and run `npm test` (the integration suite will use the configured connection).

## Troubleshooting

| Symptom                                          | Fix                                                                                    |
|--------------------------------------------------|----------------------------------------------------------------------------------------|
| `Configuration not found: databases.json`        | Run `npm run setup`, or copy `databases.example.json`. The error lists every path it searched |
| `references environment variables that are not set` | A `${VAR}` in `databases.json` has no value in `.env`. The error names the variable and which profile uses it |
| `Unknown database profile "x"`                   | The name is not in `databases.json`; the error lists the valid ones |
| Works in your terminal but not from the client   | The client starts the server from a different directory. Regenerate the config: `npm run generate-config -- --merge` |
| `.env` values look corrupted on Windows          | The file was written with a UTF-8 BOM or CRLF. Re-run setup, which writes it correctly |
| `stdin is not connected to an MCP client`        | Started without stdin — use `docker run -i`, not the Desktop Run button or `compose up` |
| Random container names piling up in Docker Desktop | Use `scripts/docker-mcp.*`; list/clean with its `ps` / `clean` actions                |
| `Database connection failed`                     | Check host/port/credentials/SSL and network access                                     |
| SSL/certificate errors                           | Set `"ssl": true` (managed providers) or `false` (plain local) on that profile        |
| `verify-permissions` exits with code 2           | Some profile's user has write privileges — the output names it; create `mcp_readonly` (see [security.md](security.md)) |
| Client sees no output / protocol errors          | Ensure nothing writes to stdout; logs must go to stderr (already enforced)             |
