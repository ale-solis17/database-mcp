#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Generates the MCP client config snippet for THIS machine.
//
// The client config always lives on the user's machine (absolute paths +
// secrets), so it can't be shipped in the repo. This script produces the
// correct snippet for whoever runs it — no manual path editing.
//
// ONE entry serves every database: the server reads all the profiles from
// databases.json and tools pick between them with a `profile` argument. Do NOT
// add a second mcpServers entry per database.
//
// Usage:
//   node scripts/generate-mcp-config.mjs            # print node + docker snippets
//   node scripts/generate-mcp-config.mjs --docker   # prefer the Docker variant
//   node scripts/generate-mcp-config.mjs --merge    # merge into Claude Desktop config
//   node scripts/generate-mcp-config.mjs --merge --docker
//   node scripts/generate-mcp-config.mjs --docker --client=code   # name the container
//   node scripts/generate-mcp-config.mjs --inline-secrets         # see below
// ─────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir, platform } from "node:os";

const args = new Set(process.argv.slice(2));
const useDocker = args.has("--docker");
const doMerge = args.has("--merge");
const inlineSecrets = args.has("--inline-secrets");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(projectRoot, "dist", "index.js");
const envPath = join(projectRoot, ".env");
const configPath = join(projectRoot, "databases.json");
const nodeExe = process.execPath; // absolute path to the running node

// ---- Read .env (best-effort) ---------------------------------------------
function readEnv(path) {
    const out = {};
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
}

// ---- Read databases.json so we can show what will be exposed --------------
function readProfiles() {
    if (!existsSync(configPath)) return null;
    try {
        let text = readFileSync(configPath, "utf8");
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const doc = JSON.parse(text);
        const names = Object.keys(doc.profiles ?? {}).filter(
            (k) => k !== "$schema" && !k.startsWith("_"),
        );
        return { names, defaultProfile: doc.defaultProfile ?? names[0] };
    } catch {
        return { names: [], defaultProfile: undefined, malformed: true };
    }
}

// ---- Build the two variants ----------------------------------------------
// Both point the server at the two absolute paths it cannot derive itself:
// an MCP client spawns the process from an arbitrary working directory, so a
// relative databases.json or a cwd-relative .env silently resolves to nothing.
const baseEnv = {
    DATABASES_CONFIG: configPath,
    DATABASE_MCP_ENV_FILE: envPath,
};

// Escape hatch: resolve the ${VAR} secrets and inline them, for people who
// would rather not have the client depend on a .env path. Off by default —
// it puts credentials into the client's config file.
function withInlineSecrets(env) {
    if (!inlineSecrets) return env;
    const fileEnv = readEnv(envPath);
    const secrets = Object.fromEntries(
        Object.entries(fileEnv).filter(([k]) => k.startsWith("MCPDB_")),
    );
    const { DATABASE_MCP_ENV_FILE: _omit, ...rest } = env;
    return { ...rest, ...secrets };
}

const nodeServer = {
    command: nodeExe,
    args: [distEntry],
    env: withInlineSecrets(baseEnv),
};

// Docker variant. `--name` is explicit so the container shows up in Docker
// Desktop as "database-mcp-<client>" instead of a random name like
// "nervous_panini", and `--label` keeps it findable/cleanable either way:
//   docker ps -a --filter label=com.database-mcp.stack=database-mcp
// Give each client a distinct name (--client) so two clients can run at once.
const clientArg = [...args].find((a) => a.startsWith("--client="));
const clientName = clientArg ? clientArg.slice("--client=".length) : doMerge ? "desktop" : "client";

const dockerServer = {
    command: "docker",
    args: [
        "run",
        "-i",
        "--rm",
        "--name",
        `database-mcp-${clientName}`,
        "--label",
        "com.database-mcp.stack=database-mcp",
        // .env carries the limits and the ${VAR} secrets…
        "--env-file",
        envPath,
        // …and databases.json is mounted read-only. It is never baked into the
        // image: it holds ${VAR} references, not values, so it stays safe to
        // mount and to read as the container's non-root user.
        "-v",
        `${configPath}:/config/databases.json:ro`,
        "-e",
        "DATABASES_CONFIG=/config/databases.json",
        "database-mcp:latest",
    ],
};

const chosen = useDocker ? dockerServer : nodeServer;

// ---- Locate the Claude Desktop config per OS -----------------------------
function desktopConfigPath() {
    const p = platform();
    if (p === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    if (p === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

// ---- Output ---------------------------------------------------------------
const log = (s) => process.stdout.write(s + "\n");
const warn = (s) => process.stderr.write(s + "\n");

const profiles = readProfiles();
function reportProfiles() {
    if (profiles === null) {
        warn("");
        warn("  [!]  databases.json not found — the server will not start.");
        warn(`       Run:  npm run setup    (or copy databases.example.json to ${configPath})`);
        return;
    }
    if (profiles.malformed) {
        warn("");
        warn("  [!]  databases.json exists but is not valid JSON — the server will not start.");
        warn("       Run:  npm run healthcheck    to see the exact problem.");
        return;
    }
    if (profiles.names.length === 0) {
        warn("");
        warn("  [!]  databases.json defines no profiles — the server will not start.");
        return;
    }
    const listed = profiles.names
        .map((n) => (n === profiles.defaultProfile ? `${n} (default)` : n))
        .join(", ");
    log("");
    log(`Profiles this server will expose: ${listed}`);
}

if (!doMerge) {
    log("");
    log("=== Claude Desktop / MCP client config ===");
    log("Add this under \"mcpServers\" in your client config.");
    log("Config file location on this OS:");
    log("  " + desktopConfigPath());
    reportProfiles();
    log("");
    log("ONE entry serves every database — do not add a second entry per database.");
    log("");
    log("--- Option A: run with local Node (recommended if you ran the setup) ---");
    log(JSON.stringify({ mcpServers: { "database-mcp": nodeServer } }, null, 2));
    log("");
    log("--- Option B: run with Docker (after `docker compose build`) ---");
    log(JSON.stringify({ mcpServers: { "database-mcp": dockerServer } }, null, 2));
    log("");
    log(`The container is named "database-mcp-${clientName}" and removed on exit.`);
    log("For a second client, re-run with --client=<name> so the names don't collide.");
    log("List/clean sessions:  scripts/docker-mcp.ps1 ps   |   scripts/docker-mcp.sh ps");
    log("");
    log("Tip: run with --merge to write it into your Claude Desktop config automatically.");
    process.exit(0);
}

// ---- Merge mode -----------------------------------------------------------
const target = desktopConfigPath();
let config = {};
if (existsSync(target)) {
    try {
        config = JSON.parse(readFileSync(target, "utf8"));
    } catch (err) {
        process.stderr.write(`Existing config is not valid JSON, aborting: ${err.message}\n`);
        process.exit(1);
    }
    copyFileSync(target, target + ".backup");
    process.stderr.write(`Backed up existing config to ${target}.backup\n`);
}

config.mcpServers = config.mcpServers ?? {};
config.mcpServers["database-mcp"] = chosen;
writeFileSync(target, JSON.stringify(config, null, 2), "utf8");
process.stderr.write(
    `Merged "database-mcp" (${useDocker ? "docker" : "node"}) into ${target}\n`,
);
reportProfiles();
process.stderr.write(
    "Restart Claude Desktop completely (Quit from the tray) to load it.\n",
);
