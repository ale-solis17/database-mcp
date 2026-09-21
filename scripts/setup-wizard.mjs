#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Database MCP Server — interactive database setup.
//
// Collects one or more database "profiles", verifies each one's connection and
// read-only permissions as it goes, and writes databases.json plus the matching
// ${VAR} secrets into .env.
//
// Invoked by setup.sh / setup.ps1 after the build. Can also be run directly:
//   node scripts/setup-wizard.mjs
//
// Why Node rather than the shell scripts: this builds JSON, writes atomically
// with backups, merges .env without clobbering it, validates names and retries
// per profile. Implementing that twice — in bash and in PowerShell 5.1 — would
// diverge, and PowerShell has its own traps here (UTF-8 BOM, ConvertTo-Json
// truncating at depth 2, CRLF in .env, SecureString marshalling). The prompts
// the user sees are identical on both platforms.
// ─────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(projectRoot, "databases.json");
const envPath = join(projectRoot, ".env");
const generatedSqlDir = join(projectRoot, "sql", "generated");

const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED_NAMES = new Set(["all", "default", "none", "profiles", "list"]);
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
const MAX_PROFILES = 20;

// ---- Terminal helpers -----------------------------------------------------

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const out = (s = "") => process.stdout.write(`${s}\n`);
const ok = (s) => out(`  \x1b[32m[OK]\x1b[0m ${s}`);
const warn = (s) => out(`  \x1b[33m[!]\x1b[0m  ${s}`);
const err = (s) => out(`  \x1b[31m[x]\x1b[0m  ${s}`);
const info = (s) => out(`  \x1b[36m[i]\x1b[0m  ${s}`);

const isTty = process.stdin.isTTY === true;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });

/**
 * Line queue in front of readline.
 *
 * `rl.question` only captures a line while a question is pending, and piped
 * input delivers every line at once — the ones arriving during the await gap
 * between two questions would be dropped on the floor, and the wizard would
 * hang at EOF. Buffering the lines ourselves makes it behave the same whether
 * a person is typing or a script is feeding it.
 */
let inputClosed = false;
const bufferedLines = [];
const waitingReaders = [];

rl.on("line", (line) => {
    const reader = waitingReaders.shift();
    if (reader) reader(line);
    else bufferedLines.push(line);
});
rl.on("close", () => {
    inputClosed = true;
    while (waitingReaders.length > 0) waitingReaders.shift()(null);
});

function readLine() {
    if (bufferedLines.length > 0) return Promise.resolve(bufferedLines.shift());
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolveLine) => waitingReaders.push(resolveLine));
}

class AbortedError extends Error {}

/** Suppresses the terminal echo for password entry. */
let muted = false;
const originalWriteToOutput = rl._writeToOutput?.bind(rl);
if (originalWriteToOutput) {
    rl._writeToOutput = function maybeMuted(text) {
        if (!muted) originalWriteToOutput(text);
    };
}

async function ask(question, fallback = "") {
    const suffix = fallback ? ` [${fallback}]` : "";
    process.stdout.write(`  ${question}${suffix}: `);
    const line = await readLine();
    if (line === null) throw new AbortedError("Input ended before setup finished.");
    const trimmed = line.trim();
    return trimmed === "" ? fallback : trimmed;
}

/** Password entry with the echo suppressed. Same behaviour on every platform. */
async function askHidden(question) {
    process.stdout.write(`  ${question}: `);
    muted = true;
    try {
        const line = await readLine();
        if (line === null) throw new AbortedError("Input ended before setup finished.");
        return line.trim();
    } finally {
        muted = false;
        out("");
    }
}

async function askYesNo(question, defaultYes = false) {
    const hint = defaultYes ? "Y/n" : "y/N";
    const answer = (await ask(`${question} (${hint})`, defaultYes ? "y" : "n")).toLowerCase();
    return answer === "y" || answer === "yes";
}

/** Hides the credentials segment of a connection string before echoing it. */
function maskUrl(url) {
    return url.replace(/(:\/\/[^:@/]*:)([^@]*)(@)/, (_m, head, _pw, tail) => `${head}${"*".repeat(8)}${tail}`);
}

// ---- File helpers ---------------------------------------------------------

function readJsonIfExists(path) {
    if (!existsSync(path)) return undefined;
    try {
        let text = readFileSync(path, "utf8");
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        return JSON.parse(text);
    } catch (e) {
        err(`${path} exists but is not valid JSON: ${e.message}`);
        err("Move it aside or fix it, then re-run setup.");
        process.exit(1);
    }
}

/**
 * Writes via a temp file in the same directory, then renames.
 *
 * Ctrl-C mid-loop must leave a parseable databases.json behind: the wizard
 * writes after every profile so an interrupted run still yields a valid,
 * partial, usable config.
 *
 * Always LF and never a BOM: `docker --env-file` keeps a trailing \r in the
 * value (breaking authentication with a useless error), and a BOM breaks
 * JSON.parse.
 */
function writeAtomic(path, content) {
    const normalized = content.replace(/\r\n/g, "\n");
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, normalized, { encoding: "utf8" });
    renameSync(tmp, path);
}

const SECRETS_HEADER = "### PROFILE SECRETS ###";

function backup(path) {
    if (!existsSync(path)) return;
    const stamp = Math.floor(Date.now() / 1000);
    writeAtomic(`${path}.backup.${stamp}`, readFileSync(path, "utf8"));
}

/**
 * Drops keys from .env.
 *
 * A profile's secret has to be written BEFORE it can be verified — the
 * healthcheck resolves the ${VAR} through .env — so abandoning a profile has
 * to take its secret back out again, or a stale credential lingers there.
 */
function removeEnvKeys(keys) {
    if (!existsSync(envPath) || keys.length === 0) return;
    const kept = readFileSync(envPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => {
            const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
            return !match || !keys.includes(match[1]);
        });
    // Take the section header with the last secret, so an abandoned setup does
    // not leave a lone "### PROFILE SECRETS ###" behind.
    while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
    if (kept.length > 0 && kept[kept.length - 1].trim() === SECRETS_HEADER) {
        kept.pop();
        while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
    }
    writeAtomic(envPath, `${kept.join("\n").replace(/\n+$/, "")}\n`);
}

/** Merges keys into .env, preserving every unrelated line and comment. */
function mergeEnv(updates) {
    const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
    const remaining = new Map(Object.entries(updates));

    const merged = lines.map((line) => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!match) return line;
        const key = match[1];
        if (!remaining.has(key)) return line;
        const value = remaining.get(key);
        remaining.delete(key);
        return `${key}=${value}`;
    });

    if (remaining.size > 0) {
        if (merged.length > 0 && merged[merged.length - 1].trim() !== "") merged.push("");
        if (!merged.some((line) => line.trim() === SECRETS_HEADER)) merged.push(SECRETS_HEADER);
        for (const [key, value] of remaining) merged.push(`${key}=${value}`);
    }

    writeAtomic(envPath, `${merged.join("\n").replace(/\n+$/, "")}\n`);
}

// ---- Profile helpers ------------------------------------------------------

function slugify(name) {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 32);
    return PROFILE_NAME_PATTERN.test(slug) ? slug : `db_${slug}`.slice(0, 32);
}

function secretVar(profileName, kind) {
    return `MCPDB_${profileName.toUpperCase()}_${kind}`;
}

function looksLikeUrl(text) {
    return /^postgres(ql)?:\/\//i.test(text);
}

/**
 * Recognises a bare host, optionally with a port: `localhost`, `db:5433`,
 * `ep-orange-glade.us-east-1.aws.neon.tech`. Deliberately narrow — anything
 * with a space, a slash or an @ is something else and should be rejected.
 */
function parseHostPort(text) {
    const match = /^([A-Za-z0-9_.-]+)(?::(\d{1,5}))?$/.exec(text);
    if (!match) return null;
    return { host: match[1], port: match[2] };
}

async function askPort(fallback) {
    for (;;) {
        const raw = await ask("Port", fallback);
        const port = Number(raw);
        if (Number.isInteger(port) && port > 0 && port < 65536) return port;
        err(`"${raw}" is not a valid port number.`);
    }
}

/** Warns about characters that .env and `docker --env-file` disagree about. */
function checkSecretValue(value) {
    const problems = [];
    if (/[#]/.test(value)) problems.push("a # (dotenv treats it as a comment, Docker does not)");
    if (/["']/.test(value)) problems.push("a quote");
    if (value !== value.trim()) problems.push("leading or trailing whitespace");
    if (/[\r\n]/.test(value)) problems.push("a line break");
    return problems;
}

async function readProfileName(existingNames, suggestion) {
    for (;;) {
        const raw = await ask("Name", suggestion);

        // Normalise silently rather than bouncing the answer back. "Brava" and
        // "Mi Base" are perfectly reasonable things to type; the lowercase
        // charset is our constraint, not the user's problem. Only say something
        // when the stored name differs from what they typed.
        const name = PROFILE_NAME_PATTERN.test(raw) ? raw : slugify(raw);
        if (name !== raw) info(`Saved as "${name}" (profile names are lowercase, digits and _).`);

        if (RESERVED_NAMES.has(name)) {
            err(`"${name}" is reserved. Reserved names: ${[...RESERVED_NAMES].join(", ")}.`);
            continue;
        }
        const clash = existingNames.find((n) => n.toLowerCase() === name.toLowerCase());
        if (clash) {
            warn(`A profile named "${clash}" already exists.`);
            if (await askYesNo("Replace it?", false)) return clash;
            continue;
        }
        return name;
    }
}

/** Collects one profile. Returns { name, entry, secrets } or null if abandoned. */
async function collectProfile(existingNames, suggestion) {
    const name = await readProfileName(existingNames, suggestion);

    out(
        dim(
            "  Paste a connection URL (Neon/Supabase/RDS/Railway), or just the host name,\n" +
                "  or press Enter to type the fields one by one.",
        ),
    );

    let entry;
    const secrets = {};
    let describedDatabase;
    // Seeds the Host/Port prompts when the answer below turns out to be a bare
    // host rather than a full connection string.
    let hostHint = "localhost";
    let portHint = "5432";

    for (;;) {
        const pasted = await ask("Connection URL or host", "");
        if (pasted === "") break; // straight to the field-by-field prompts

        if (!looksLikeUrl(pasted)) {
            const host = parseHostPort(pasted);
            if (host) {
                // Pasting the host alone is a natural mistake (it is the part of
                // the Neon dashboard that looks most like "the address"). Take it
                // and ask for the rest instead of throwing the answer away.
                hostHint = host.host;
                if (host.port) portHint = host.port;
                info(`Not a connection string — using "${host.host}" as the host, asking for the rest.`);
                break;
            }
            err(
                "That is neither a postgres:// connection string nor a host name. " +
                    "Press Enter to type the fields one by one.",
            );
            continue;
        }

        let parsed;
        try {
            parsed = new URL(pasted);
        } catch {
            err("That connection string could not be parsed. Check for a stray space or line break.");
            continue;
        }
        const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
        if (database === "") {
            err('That connection string has no database name after the host (expected ".../neondb").');
            continue;
        }

        out(`  ${dim(maskUrl(pasted))}`);
        const variable = secretVar(name, "URL");
        entry = { url: `\${${variable}}` };
        secrets[variable] = pasted;
        describedDatabase = database;
        break;
    }

    if (entry === undefined) {
        const host = await ask("Host", hostHint);
        const port = await askPort(portHint);
        let database = "";
        while (database === "") {
            database = await ask("Database", "");
            if (database === "") err("A database name is required (for example: neondb, postgres).");
        }
        const user = await ask("User", "mcp_readonly");
        let password = await askHidden("Password");
        // An empty password is nearly always a stray Enter, and it surfaces
        // later as an "environment variable is not set" error that points at
        // the config file rather than at this prompt.
        while (password === "" && !(await askYesNo("The password is empty. Continue anyway?", false))) {
            password = await askHidden("Password");
        }
        const ssl = await askYesNo("Use SSL?", !LOCAL_HOSTS.includes(host));

        const variable = secretVar(name, "PASSWORD");
        entry = {
            type: "postgres",
            host,
            port,
            database,
            user,
            password: `\${${variable}}`,
            ssl,
        };
        secrets[variable] = password;
        describedDatabase = database;
    }

    for (const [variable, value] of Object.entries(secrets)) {
        const problems = checkSecretValue(value);
        for (const problem of problems) {
            warn(`${variable} contains ${problem} — this can behave differently in Docker.`);
        }
    }

    const description = await ask("Description (optional)", name);
    if (description) entry.description = description;

    return { name, entry, secrets, database: describedDatabase };
}

// ---- Verification ---------------------------------------------------------

function runNode(script, args) {
    return spawnSync(process.execPath, [join(projectRoot, "dist", script), ...args], {
        cwd: projectRoot,
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
    });
}

function verifyConnection(name) {
    const result = runNode("healthcheck.js", [`--profile=${name}`]);
    return { ok: result.status === 0, output: (result.stderr ?? "").trim() };
}

function verifyPermissions(name) {
    const result = runNode("verify-permissions.js", [`--profile=${name}`]);
    return { status: result.status, output: (result.stderr ?? "").trim() };
}

// ---- Generated SQL --------------------------------------------------------

function writeReadonlySql(profileName, databaseName) {
    const password = randomBytes(18).toString("base64url");
    const sql = `-- ============================================================================
-- READ-ONLY role for the Database MCP Server — profile "${profileName}"
-- Generated by setup on ${new Date().toISOString()}
-- ============================================================================
-- Run this as a superuser or the owner of "${databaseName}", CONNECTED TO THAT
-- DATABASE. Then re-run setup and enter this password for profile
-- "${profileName}".
--
-- NOTE: the role is cluster-wide, the grants are per database. Adding a second
-- database on the SAME server reuses this role — that is why step 1 is guarded.
-- ============================================================================

-- 1. Create the login role (cluster-wide; skipped if it already exists).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    CREATE ROLE mcp_readonly WITH LOGIN PASSWORD '${password}';
  END IF;
END $$;

-- 2. Allow connecting to this database.
GRANT CONNECT ON DATABASE "${databaseName}" TO mcp_readonly;

-- 3. Read access to ALL data in every schema, current and future (PG 14+).
GRANT pg_read_all_data TO mcp_readonly;

-- 4. Force every transaction from this role to be read-only (cluster-wide).
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;

-- If the role already existed with a different password, this file's password
-- will NOT apply. Either reuse the existing password, or set this one:
--   ALTER ROLE mcp_readonly WITH PASSWORD '${password}';
`;

    mkdirSync(generatedSqlDir, { recursive: true });
    const path = join(generatedSqlDir, `${profileName}.create_readonly_user.sql`);
    writeAtomic(path, sql);
    return { path, password };
}

// ---- Config assembly ------------------------------------------------------

/**
 * Writes databases.json — or removes it when no profiles are left.
 *
 * An empty `"profiles": {}` is not a harmless placeholder: the server rejects
 * it at startup, so an abandoned setup would leave behind a config that only
 * produces errors. No file at all gives the much better "run npm run setup"
 * message instead.
 */
function writeConfig(doc) {
    if (profileNamesOf(doc).length === 0) {
        if (existsSync(configPath)) rmSync(configPath);
        return;
    }
    writeAtomic(configPath, `${JSON.stringify(doc, null, 2)}\n`);
}

function profileNamesOf(doc) {
    return Object.keys(doc.profiles ?? {}).filter((k) => k !== "$schema" && !k.startsWith("_"));
}

function emptyConfig() {
    return { $schema: "./databases.schema.json", defaultProfile: undefined, profiles: {} };
}

/** Drops `defaultProfile` when unset so the JSON stays clean. */
function serializable(doc) {
    const copy = { $schema: doc.$schema, profiles: doc.profiles };
    if (doc.defaultProfile) {
        return { $schema: doc.$schema, defaultProfile: doc.defaultProfile, profiles: doc.profiles };
    }
    return copy;
}

// ---- Main flow ------------------------------------------------------------

async function addProfilesLoop(doc) {
    let added = 0;

    for (;;) {
        const names = profileNamesOf(doc);
        if (names.length >= MAX_PROFILES) {
            warn(`Reached the limit of ${MAX_PROFILES} profiles.`);
            break;
        }

        out("");
        out(bold(`  --- Profile ${names.length + 1} ---`));
        const suggestion = names.length === 0 ? "main" : `db${names.length + 1}`;
        const collected = await collectProfile(names, suggestion);

        if (collected) {
            const kept = await addAndVerify(doc, collected);
            if (kept) added++;
        }

        out("");
        if (!(await askYesNo("Add another database?", false))) break;
    }

    return added;
}

/** Writes the profile, verifies it, and offers a way out if it does not work. */
async function addAndVerify(doc, collected) {
    for (;;) {
        doc.profiles[collected.name] = collected.entry;
        if (!doc.defaultProfile) doc.defaultProfile = collected.name;
        writeConfig(serializable(doc));
        mergeEnv(collected.secrets);

        process.stdout.write("  Checking connection...            ");
        const connection = verifyConnection(collected.name);

        if (connection.ok) {
            out("\x1b[32m[OK]\x1b[0m connected");
            process.stdout.write("  Checking read-only permissions... ");
            const permissions = verifyPermissions(collected.name);

            if (permissions.status === 0) {
                out("\x1b[32m[OK]\x1b[0m user appears read-only.");
            } else if (permissions.status === 2) {
                out("\x1b[33m[!]\x1b[0m  user is NOT strictly read-only.");
                for (const line of permissions.output.split("\n")) {
                    if (line.includes(" - ")) out(`      ${line.trim()}`);
                }
                await offerReadonlySql(collected);
            } else {
                out("\x1b[33m[!]\x1b[0m  could not verify permissions (continuing).");
            }
            return true;
        }

        out("\x1b[31m[x]\x1b[0m  could not connect");
        for (const line of connection.output.split("\n").slice(0, 3)) {
            if (line.trim()) out(`      ${dim(line.trim())}`);
        }

        const choice = (
            await ask("[R]etry, [E]dit the details, [S]kip this database, [K]eep anyway", "R")
        ).toUpperCase();

        if (choice === "R") continue;
        if (choice === "K") return true;
        if (choice === "E") {
            const names = profileNamesOf(doc).filter((n) => n !== collected.name);
            const again = await collectProfile(names, collected.name);
            if (!again) continue;
            collected = again;
            continue;
        }

        // Skip: remove it again so neither an abandoned profile nor its
        // credentials linger behind.
        delete doc.profiles[collected.name];
        if (doc.defaultProfile === collected.name) {
            doc.defaultProfile = profileNamesOf(doc)[0];
        }
        writeConfig(serializable(doc));
        removeEnvKeys(Object.keys(collected.secrets));
        warn(`Profile "${collected.name}" was not added.`);
        return false;
    }
}

async function offerReadonlySql(collected) {
    if (!collected.database) return;
    out("");
    if (!(await askYesNo(`Generate a SQL script to create mcp_readonly on "${collected.database}"?`, true))) {
        return;
    }
    const { path } = writeReadonlySql(collected.name, collected.database);
    ok(`${path}`);
    out(dim("      Contains a generated password and is git-ignored."));
    out(dim("      Run it as a superuser, then re-run setup for this profile."));
}

async function chooseDefault(doc) {
    const names = profileNamesOf(doc);
    if (names.length <= 1) {
        doc.defaultProfile = names[0];
        return;
    }
    out("");
    const current = doc.defaultProfile && names.includes(doc.defaultProfile) ? doc.defaultProfile : names[0];
    for (;;) {
        const answer = await ask(`Which profile should be the default? (${names.join(", ")})`, current);
        if (names.includes(answer)) {
            doc.defaultProfile = answer;
            return;
        }
        err(`"${answer}" is not one of: ${names.join(", ")}.`);
    }
}

async function handleExistingConfig(doc) {
    const names = profileNamesOf(doc);
    if (names.length === 0) return "add";

    const listed = names
        .map((n) => (n === doc.defaultProfile ? `${n} (default)` : n))
        .join(", ");
    out("");
    out(`  Found databases.json with ${names.length} profile(s): ${listed}`);
    out("  What now?");
    out("    [A] Add another database   (keeps the existing ones)");
    out("    [E] Edit / replace one of them");
    out("    [D] Change which one is the default");
    out("    [S] Start over             (backs up the current file)");
    out("    [Q] Keep as-is and skip to the MCP client config");

    for (;;) {
        const choice = (await ask("Choice", "A")).toUpperCase();
        if (["A", "E", "D", "S", "Q"].includes(choice)) return choice.toLowerCase();
        err("Pick A, E, D, S or Q.");
    }
}

async function main() {
    out("");
    out(bold("Database profiles"));
    out(
        dim(
            "  A profile is one database this server can query. Add as many as you like —\n" +
                "  the AI picks between them with the \"profile\" argument, and one is the default.",
        ),
    );

    const existing = readJsonIfExists(configPath);
    let doc = existing
        ? { $schema: existing.$schema ?? "./databases.schema.json", defaultProfile: existing.defaultProfile, profiles: existing.profiles ?? {} }
        : emptyConfig();

    let action = "add";
    if (existing) action = await handleExistingConfig(doc);

    if (action === "q") {
        rl.close();
        return;
    }

    if (action === "s") {
        backup(configPath);
        warn("Existing databases.json backed up.");
        doc = emptyConfig();
        action = "add";
    }

    if (action === "d") {
        await chooseDefault(doc);
        writeConfig(serializable(doc));
        ok(`Default profile is now "${doc.defaultProfile}".`);
        rl.close();
        return;
    }

    if (action === "e") {
        const names = profileNamesOf(doc);
        const which = await ask(`Which profile? (${names.join(", ")})`, names[0]);
        if (!names.includes(which)) {
            err(`"${which}" is not one of: ${names.join(", ")}.`);
            rl.close();
            process.exit(1);
        }
        out("");
        out(bold(`  --- Editing "${which}" ---`));
        const collected = await collectProfile(names.filter((n) => n !== which), which);
        if (collected) await addAndVerify(doc, collected);
    } else {
        await addProfilesLoop(doc);
    }

    const names = profileNamesOf(doc);
    if (names.length === 0) {
        out("");
        err("No databases were configured. The server cannot start without at least one.");
        err("Re-run setup when you have the connection details.");
        rl.close();
        process.exit(1);
    }

    await chooseDefault(doc);
    writeConfig(serializable(doc));

    out("");
    ok(`databases.json written — ${names.length} profile(s), default "${doc.defaultProfile}"`);
    ok(`.env updated — secrets kept out of databases.json`);

    rl.close();
}

main().catch((e) => {
    out("");
    if (e instanceof AbortedError) {
        err("Setup was interrupted before it finished.");
        err("Anything already verified was saved; re-run setup to continue.");
    } else {
        err(e instanceof Error ? e.message : String(e));
    }
    rl.close();
    process.exit(1);
});
