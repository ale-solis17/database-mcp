#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Generates the MCP client config snippet for THIS machine.
//
// The client config always lives on the user's machine (absolute paths +
// secrets), so it can't be shipped in the repo. This script produces the
// correct snippet for whoever runs it — no manual path editing.
//
// Usage:
//   node scripts/generate-mcp-config.mjs            # print node + docker snippets
//   node scripts/generate-mcp-config.mjs --docker   # prefer the Docker variant
//   node scripts/generate-mcp-config.mjs --merge     # merge into Claude Desktop config
//   node scripts/generate-mcp-config.mjs --merge --docker
//   node scripts/generate-mcp-config.mjs --docker --client=code   # name the container
// ─────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir, platform } from "node:os";

const args = new Set(process.argv.slice(2));
const useDocker = args.has("--docker");
const doMerge = args.has("--merge");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(projectRoot, "dist", "index.js");
const envPath = join(projectRoot, ".env");
const nodeExe = process.execPath; // absolute path to the running node

// ---- Read .env (best-effort; falls back to placeholders) -----------------
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

const e = readEnv(envPath);
const P = (k, def) => e[k] ?? def;
const env = {
    DB_TYPE: P("DB_TYPE", "postgres"),
    DB_HOST: P("DB_HOST", "<host>"),
    DB_PORT: P("DB_PORT", "5432"),
    DB_NAME: P("DB_NAME", "<database>"),
    DB_USER: P("DB_USER", "<readonly_user>"),
    DB_PASSWORD: P("DB_PASSWORD", "<password>"),
    DB_SSL: P("DB_SSL", "true"),
    MAX_ROWS: P("MAX_ROWS", "1000"),
    QUERY_TIMEOUT_MS: P("QUERY_TIMEOUT_MS", "10000"),
    MAX_RESULT_SIZE_MB: P("MAX_RESULT_SIZE_MB", "10"),
};

// ---- Build the two variants ----------------------------------------------
const nodeServer = {
    command: nodeExe,
    args: [distEntry],
    env,
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
        "--env-file",
        envPath,
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

if (!doMerge) {
    log("");
    log("=== Claude Desktop / MCP client config ===");
    log("Add this under \"mcpServers\" in your client config.");
    log("Config file location on this OS:");
    log("  " + desktopConfigPath());
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
    `Merged "database-mcp" (${useDocker ? "docker" : "node"}) into ${target}\n` +
        "Restart Claude Desktop completely (Quit from the tray) to load it.\n",
);
