import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEnvFile } from "./load-env-file.js";
import {
    databaseConfigCandidates,
    fileExists,
    hasExplicitConfigOverride,
    resolveProjectPath,
    resolveUserPath,
    type PathCandidate,
} from "./paths.js";
import type {
    DatabaseConfig,
    DatabaseType,
    ProfileConfig,
    ProfilesConfig,
} from "../types/database.types.js";

/**
 * Loads, interpolates and validates `databases.json` — the list of named
 * databases ("profiles") this server can query.
 *
 * Every error thrown from here is a `ConfigError`, whose message is written for
 * a human to act on and is printed raw (no stack, no JSON). Problems are
 * aggregated per stage so an operator fixes everything in one pass instead of
 * one restart at a time.
 */

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

const SUPPORTED_TYPES = ["postgres", "mysql", "sqlserver"] as const;
const IMPLEMENTED_TYPES: DatabaseType[] = ["postgres"];

const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED_PROFILE_NAMES = new Set(["all", "default", "none", "profiles", "list"]);

/** Hosts that do not get SSL by default. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Legacy single-database variables, used to detect an un-migrated setup. */
const LEGACY_VARS = [
    "DB_TYPE",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "DB_SSL",
] as const;

export interface LoadOptions {
    /** Explicit file path; overrides DATABASES_CONFIG and the search order. */
    path?: string;
    /** Variable source for ${VAR} interpolation. Defaults to process.env. */
    env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadProfilesConfig(options: LoadOptions = {}): ProfilesConfig {
    // Only when falling back to the real environment: an injected `env` is the
    // caller's own (tests), and must not be contaminated by the project's .env.
    if (options.env === undefined) loadEnvFile();
    const env = options.env ?? process.env;
    const sourcePath = locate(options.path, env);
    const raw = readAndParse(sourcePath);
    const interpolated = interpolate(raw, env, sourcePath);
    return validate(interpolated, sourcePath);
}

let cached: ProfilesConfig | undefined;

/** Memoized accessor for the running server. */
export function getProfilesConfig(): ProfilesConfig {
    cached ??= loadProfilesConfig();
    return cached;
}

/** Test seam: forget the memoized config. */
export function resetProfilesConfigCache(): void {
    cached = undefined;
}

/** Whether an engine has an adapter implementation today. */
export function isImplementedEngine(type: DatabaseType): boolean {
    return IMPLEMENTED_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// 1. Locate
// ---------------------------------------------------------------------------

function locate(explicitPath: string | undefined, env: NodeJS.ProcessEnv): string {
    if (explicitPath) {
        const resolved = resolveUserPath(explicitPath);
        if (!fileExists(resolved)) {
            throw new ConfigError(`Configuration file not found: ${resolved}`);
        }
        return resolved;
    }

    const candidates = databaseConfigCandidates(env);

    // An explicit DATABASES_CONFIG that does not exist is a hard error, never a
    // fall-through: a typo'd bind-mount would otherwise silently serve whatever
    // databases.json happens to sit in the project root — the wrong database.
    if (hasExplicitConfigOverride(env) && !fileExists(candidates[0]!.path)) {
        throw new ConfigError(
            `DATABASES_CONFIG points at a file that does not exist:\n  ${candidates[0]!.path}\n\n` +
                "Fix the path or unset DATABASES_CONFIG to use the default location.",
        );
    }

    const found = candidates.find((c) => fileExists(c.path));
    if (!found) throw missingConfigError(candidates, env);
    return found.path;
}

function missingConfigError(candidates: PathCandidate[], env: NodeJS.ProcessEnv): ConfigError {
    const legacy = LEGACY_VARS.filter((name) => (env[name] ?? "").trim() !== "");
    const searched = candidates.map((c) => `  ${c.path}${padLabel(c)}`).join("\n");

    const lines = ["Configuration not found: databases.json", ""];

    if (legacy.length > 0) {
        lines.push(
            'This server now supports MULTIPLE databases ("profiles") and no longer reads',
            "DB_HOST / DB_NAME / DB_USER / DB_PASSWORD from the environment.",
            "",
            `Detected legacy variables in your environment: ${legacy.join(", ")}`,
            "",
            "Fix it automatically (recommended):",
            "  npm run setup            # migrates your existing .env into databases.json",
            "",
            `Or create ${resolveProjectPath("databases.json")} by hand:`,
            "",
            legacyMigrationSample(env),
            "",
            "Keep the password in .env as MCPDB_MAIN_PASSWORD=... — ${VAR} is read from",
            ".env so secrets never live in databases.json.",
        );
    } else {
        lines.push(
            'This server reads its database connections from databases.json ("profiles").',
            "",
            "Create it:",
            "  npm run setup                              # interactive, writes it for you",
            "  cp databases.example.json databases.json   # or start from the example",
        );
    }

    lines.push(
        "",
        "Searched for the config file at:",
        searched,
        "",
        "Set DATABASES_CONFIG=/absolute/path/databases.json to use a different location.",
    );

    return new ConfigError(lines.join("\n"));
}

function padLabel(candidate: PathCandidate): string {
    return `  (${candidate.label})`;
}

/**
 * A ready-to-paste databases.json built from the legacy variables actually
 * present, so migrating is copy-and-paste rather than copy-edit-and-paste.
 */
function legacyMigrationSample(env: NodeJS.ProcessEnv): string {
    const value = (name: string, fallback: string): string => {
        const raw = (env[name] ?? "").trim();
        return raw === "" ? fallback : raw;
    };
    const host = value("DB_HOST", "<your DB_HOST>");
    const port = Number(value("DB_PORT", "5432")) || 5432;
    const profile = {
        type: value("DB_TYPE", "postgres").toLowerCase(),
        host,
        port,
        database: value("DB_NAME", "<your DB_NAME>"),
        user: value("DB_USER", "<your DB_USER>"),
        password: "${MCPDB_MAIN_PASSWORD}",
        ssl: !LOCAL_HOSTS.includes(host),
        description: "Main database",
    };
    const doc = { defaultProfile: "main", profiles: { main: profile } };
    return JSON.stringify(doc, null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
}

// ---------------------------------------------------------------------------
// 2. Read + parse
// ---------------------------------------------------------------------------

function readAndParse(path: string): unknown {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (err) {
        throw new ConfigError(
            `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // A UTF-8 BOM (what PowerShell's `Set-Content -Encoding utf8` writes) makes
    // JSON.parse fail with a message that explains nothing. Strip it.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    try {
        return JSON.parse(text) as unknown;
    } catch (err) {
        throw new ConfigError(
            `${path} is not valid JSON.\n` +
                `  ${err instanceof Error ? err.message : String(err)}\n\n` +
                "Tip: trailing commas, single quotes and comments are not valid JSON.\n" +
                "Use _readme / _comment keys for notes — the server ignores them.",
        );
    }
}

// ---------------------------------------------------------------------------
// 3. ${VAR} interpolation
// ---------------------------------------------------------------------------

const VAR_PATTERN = /\$\$\{([A-Za-z_][A-Za-z0-9_]*)}|\$\{([A-Za-z_][A-Za-z0-9_]*)}/g;

interface MissingVar {
    name: string;
    location: string;
}

/**
 * Replaces `${VAR}` in every string value with the matching variable.
 *
 * Deliberately walks the PARSED value rather than the raw file text: running a
 * regex over the text would corrupt JSON escaping (a password containing `"`
 * or `\` is escaped in the file and must stay that way until after parsing).
 * `$${VAR}` is an escape for a literal `${VAR}` — passwords do contain `$`.
 */
function interpolate(value: unknown, env: NodeJS.ProcessEnv, sourcePath: string): unknown {
    const missing: MissingVar[] = [];
    const result = walk(value, "", env, missing);

    if (missing.length > 0) {
        const width = Math.max(...missing.map((m) => m.name.length + 3));
        const list = missing
            .map((m) => `  \${${m.name}}`.padEnd(width + 2) + `  (${m.location})`)
            .join("\n");
        const first = missing[0]!.name;
        throw new ConfigError(
            `${sourcePath} references environment variables that are not set:\n` +
                `${list}\n\n` +
                `Add them to your .env file, e.g.\n` +
                `  ${first}=your-value-here\n\n` +
                "Secrets belong in .env (git-ignored), not in databases.json.\n" +
                "If the server is spawned by an MCP client, make sure the client passes\n" +
                "DATABASE_MCP_ENV_FILE with the absolute path to that .env — a client\n" +
                "starts the server from an arbitrary directory.",
        );
    }
    return result;
}

function walk(
    value: unknown,
    path: string,
    env: NodeJS.ProcessEnv,
    missing: MissingVar[],
): unknown {
    if (typeof value === "string") {
        return substitute(value, path, env, missing);
    }
    if (Array.isArray(value)) {
        return value.map((item, i) => walk(item, `${path}[${i}]`, env, missing));
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            // Documentation keys are copied verbatim: _readme explains the
            // ${VAR} syntax, so interpolating it would report the example
            // itself as an undefined variable.
            out[key] = isIgnoredKey(key)
                ? item
                : walk(item, path === "" ? key : `${path}.${key}`, env, missing);
        }
        return out;
    }
    return value;
}

function substitute(
    text: string,
    path: string,
    env: NodeJS.ProcessEnv,
    missing: MissingVar[],
): string {
    return text.replace(VAR_PATTERN, (_match, escaped: string | undefined, name: string | undefined) => {
        // `$${VAR}` -> literal `${VAR}`.
        if (escaped !== undefined) return `\${${escaped}}`;

        const varName = name!;
        const resolved = env[varName];
        if (resolved === undefined || resolved.trim() === "") {
            missing.push({ name: varName, location: path || "(root)" });
            return "";
        }
        return resolved;
    });
}

// ---------------------------------------------------------------------------
// 4. Validation
// ---------------------------------------------------------------------------

const engineSchema = z.enum(SUPPORTED_TYPES).default("postgres");

const fieldsProfileSchema = z.object({
    type: engineSchema,
    host: z.string().min(1, "host must not be empty"),
    port: z.coerce.number().int().positive().default(5432),
    database: z.string().min(1, "database must not be empty"),
    user: z.string().min(1, "user must not be empty"),
    password: z.string(),
    ssl: z.coerce.boolean().optional(),
    description: z.string().optional(),
});

const urlProfileSchema = z.object({
    type: engineSchema,
    url: z.string().min(1, "url must not be empty"),
    ssl: z.coerce.boolean().optional(),
    description: z.string().optional(),
});

const FIELDS_KEYS = ["type", "host", "port", "database", "user", "password", "ssl", "description"];
const URL_KEYS = ["type", "url", "ssl", "description"];
const ROOT_KEYS = ["defaultProfile", "profiles"];

function validate(raw: unknown, sourcePath: string): ProfilesConfig {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ConfigError(`${sourcePath} must contain a JSON object at the top level.`);
    }
    const doc = raw as Record<string, unknown>;

    rejectUnknownKeys(doc, ROOT_KEYS, "(root)", sourcePath);

    const profilesRaw = doc.profiles;
    if (profilesRaw === undefined) {
        throw new ConfigError(
            `${sourcePath} has no "profiles" key.\n` +
                "It must map profile names to database settings — see databases.example.json.",
        );
    }
    if (profilesRaw === null || typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) {
        throw new ConfigError(`${sourcePath}: "profiles" must be an object mapping names to databases.`);
    }

    const entries = Object.entries(profilesRaw as Record<string, unknown>).filter(
        ([key]) => !isIgnoredKey(key),
    );
    if (entries.length === 0) {
        throw new ConfigError(
            `${sourcePath} defines no profiles.\n` +
                'Add at least one database under "profiles" — see databases.example.json.',
        );
    }

    const profiles = entries.map(([name, value]) => parseProfile(name, value, sourcePath));
    const names = profiles.map((p) => p.name);

    const defaultProfile = resolveDefaultProfile(doc.defaultProfile, names, sourcePath);

    // Default first so list_databases output is stable and self-explanatory.
    profiles.sort((a, b) =>
        a.name === defaultProfile ? -1 : b.name === defaultProfile ? 1 : 0,
    );

    return { defaultProfile, profiles, sourcePath };
}

/** `$schema` and any `_`-prefixed key are documentation, not configuration. */
function isIgnoredKey(key: string): boolean {
    return key === "$schema" || key.startsWith("_");
}

function rejectUnknownKeys(
    obj: Record<string, unknown>,
    allowed: string[],
    where: string,
    sourcePath: string,
): void {
    const unknown = Object.keys(obj).filter((k) => !isIgnoredKey(k) && !allowed.includes(k));
    if (unknown.length === 0) return;

    const details = unknown.map((key) => {
        const suggestion = closestMatch(key, allowed);
        return suggestion ? `  "${key}" — did you mean "${suggestion}"?` : `  "${key}"`;
    });
    throw new ConfigError(
        `${sourcePath}: unknown key(s) in ${where}:\n` +
            `${details.join("\n")}\n\n` +
            `Known keys here: ${allowed.join(", ")}.\n` +
            "Notes go in keys starting with _ , which the server ignores.",
    );
}

/** Returns the allowed key within edit distance 1, if any. */
function closestMatch(input: string, candidates: string[]): string | undefined {
    const lower = input.toLowerCase();
    return candidates.find((c) => editDistanceWithin1(lower, c.toLowerCase()));
}

function editDistanceWithin1(a: string, b: string): boolean {
    if (a === b) return true;
    const diff = a.length - b.length;
    if (diff > 1 || diff < -1) return false;

    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < shorter.length && j < longer.length) {
        if (shorter[i] === longer[j]) {
            i++;
            j++;
            continue;
        }
        if (++edits > 1) return false;
        if (shorter.length === longer.length) i++;
        j++;
    }
    return true;
}

function parseProfile(name: string, value: unknown, sourcePath: string): ProfileConfig {
    assertValidProfileName(name, sourcePath);

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ConfigError(
            `${sourcePath}: profile "${name}" must be an object with connection settings.`,
        );
    }
    const raw = value as Record<string, unknown>;
    const usesUrl = "url" in raw;

    // A manual branch, not z.union: a union reports "host is required" for a
    // profile that legitimately uses `url`, which sends people the wrong way.
    rejectUnknownKeys(raw, usesUrl ? URL_KEYS : FIELDS_KEYS, `profile "${name}"`, sourcePath);

    if (usesUrl) {
        const parsed = parseWith(urlProfileSchema, raw, name, sourcePath);
        return {
            name,
            description: parsed.description,
            config: fromUrl(name, parsed.url, parsed.type, parsed.ssl, sourcePath),
        };
    }

    if (!("host" in raw) && !("database" in raw)) {
        throw new ConfigError(
            `${sourcePath}: profile "${name}" has no connection settings.\n` +
                'Give it either "url", or the fields host / database / user / password.\n' +
                "See databases.example.json for one of each.",
        );
    }

    const parsed = parseWith(fieldsProfileSchema, raw, name, sourcePath);
    return {
        name,
        description: parsed.description,
        config: {
            type: parsed.type,
            host: parsed.host,
            port: parsed.port,
            database: parsed.database,
            user: parsed.user,
            password: parsed.password,
            ssl: parsed.ssl ?? !LOCAL_HOSTS.includes(parsed.host),
        },
    };
}

function parseWith<T extends z.ZodType>(
    schema: T,
    raw: unknown,
    name: string,
    sourcePath: string,
): z.infer<T> {
    const result = schema.safeParse(raw);
    if (result.success) return result.data as z.infer<T>;

    const issues = result.error.issues
        .map((issue) => {
            const field = issue.path.join(".");
            return field ? `  ${field}: ${issue.message}` : `  ${issue.message}`;
        })
        .join("\n");
    throw new ConfigError(`${sourcePath}: profile "${name}" is not valid:\n${issues}`);
}

function assertValidProfileName(name: string, sourcePath: string): void {
    if (RESERVED_PROFILE_NAMES.has(name)) {
        throw new ConfigError(
            `${sourcePath}: "${name}" is a reserved profile name.\n` +
                `Reserved: ${[...RESERVED_PROFILE_NAMES].join(", ")}. Pick another name.`,
        );
    }
    if (!PROFILE_NAME_PATTERN.test(name)) {
        throw new ConfigError(
            `${sourcePath}: "${name}" is not a valid profile name.\n` +
                "Use lowercase letters, digits and underscore, starting with a letter\n" +
                `(max 32 characters). Suggested: "${slugify(name)}".`,
        );
    }
}

function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 32);
    return PROFILE_NAME_PATTERN.test(slug) ? slug : `db_${slug}`.slice(0, 32);
}

function resolveDefaultProfile(
    raw: unknown,
    names: string[],
    sourcePath: string,
): string {
    if (raw === undefined) {
        if (names.length === 1) return names[0]!;
        throw new ConfigError(
            `${sourcePath} defines ${names.length} profiles but no "defaultProfile".\n` +
                `Add one, e.g. "defaultProfile": "${names[0]}".\n` +
                `Configured profiles: ${names.join(", ")}.`,
        );
    }
    if (typeof raw !== "string") {
        throw new ConfigError(`${sourcePath}: "defaultProfile" must be a string.`);
    }
    if (!names.includes(raw)) {
        throw new ConfigError(
            `${sourcePath}: defaultProfile "${raw}" is not one of the configured profiles.\n` +
                `Configured profiles: ${names.join(", ")}.`,
        );
    }
    return raw;
}

// ---------------------------------------------------------------------------
// 5. Connection-string form
// ---------------------------------------------------------------------------

/**
 * Turns a connection string into a DatabaseConfig.
 *
 * Node's URL rather than pg's own parser: PostgresAdapter keeps `database` for
 * getDatabaseOverview(), and list_databases shows host/database/user, so a
 * DatabaseConfig with discrete fields has to exist either way. One code path
 * for both profile styles is worth more than reusing pg's parsing.
 */
function fromUrl(
    name: string,
    raw: string,
    type: DatabaseType,
    sslOverride: boolean | undefined,
    sourcePath: string,
): DatabaseConfig {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(
            `${sourcePath}: profile "${name}" has a "url" that is not a valid connection string.\n` +
                "Expected something like:\n" +
                "  postgresql://user:password@host:5432/database?sslmode=require\n" +
                "Special characters in the password must be percent-encoded (@ as %40, / as %2F).",
        );
    }

    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new ConfigError(
            `${sourcePath}: profile "${name}" has a "url" with protocol "${url.protocol.replace(":", "")}".\n` +
                "Only postgres:// and postgresql:// are supported today.",
        );
    }

    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!database) {
        throw new ConfigError(
            `${sourcePath}: profile "${name}" has a "url" with no database name.\n` +
                "Add it as the path, e.g. postgresql://user:pw@host:5432/mydb",
        );
    }

    const user = decodeURIComponent(url.username);
    if (!user) {
        throw new ConfigError(
            `${sourcePath}: profile "${name}" has a "url" with no username.\n` +
                "Expected postgresql://USER:password@host:5432/database\n" +
                "If the username contains @ or /, percent-encode it (%40, %2F).",
        );
    }

    // sslmode is the only query parameter that maps onto our config; extras
    // such as Neon's channel_binding are ignored.
    const sslmode = url.searchParams.get("sslmode");
    const ssl =
        sslOverride ??
        (sslmode !== null
            ? !["disable", "allow"].includes(sslmode)
            : !LOCAL_HOSTS.includes(url.hostname));

    return {
        type,
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        database,
        user,
        password: decodeURIComponent(url.password),
        ssl,
    };
}
