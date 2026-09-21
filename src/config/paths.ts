import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Cwd-independent path resolution.
 *
 * CRITICAL: an MCP client spawns this server with an ARBITRARY working
 * directory (Claude Desktop uses `/`, other clients use the workspace root).
 * Anything resolved from `process.cwd()` therefore points somewhere random —
 * `databases.json` is silently "not found", or worse, a different one is found.
 * This is the classic "works in my terminal, not from the client" bug.
 *
 * `tsconfig.json` maps `src/ -> dist/` one-to-one (rootDir/outDir), so this
 * module lives two levels below the package root both as `src/config/paths.ts`
 * (under tsx) and as `dist/config/paths.js` (built). Deriving the root from
 * `import.meta.url` is therefore identical in both, and inside Docker too.
 */
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolves a path inside the package root. */
export function resolveProjectPath(...segments: string[]): string {
    return resolve(projectRoot, ...segments);
}

/** Resolves a user-supplied path: absolute as-is, relative against the cwd. */
export function resolveUserPath(candidate: string): string {
    return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

/** A candidate location, kept alongside a label for "searched here" messages. */
export interface PathCandidate {
    path: string;
    label: string;
}

/**
 * Where `databases.json` may live, in priority order.
 *
 * Returned rather than resolved here so the caller can report every location it
 * tried when none exists — a "file not found" that does not say where it looked
 * is useless when the cwd is not what the user assumes.
 */
export function databaseConfigCandidates(env: NodeJS.ProcessEnv = process.env): PathCandidate[] {
    const candidates: PathCandidate[] = [];
    const override = env.DATABASES_CONFIG?.trim();
    if (override) {
        candidates.push({ path: resolveUserPath(override), label: "DATABASES_CONFIG" });
    }
    candidates.push({ path: resolveProjectPath("databases.json"), label: "project root" });
    const fromCwd = resolve(process.cwd(), "databases.json");
    if (!candidates.some((c) => c.path === fromCwd)) {
        candidates.push({ path: fromCwd, label: "current directory" });
    }
    return candidates;
}

/** True when DATABASES_CONFIG was set explicitly (an explicit miss must not fall through). */
export function hasExplicitConfigOverride(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.DATABASES_CONFIG?.trim());
}

/**
 * The `.env` file holding the `${VAR}` secrets that databases.json references.
 *
 * Same cwd trap as above: `dotenv/config` reads `process.cwd()/.env`, which
 * under an MCP client loads nothing at all, leaving every `${VAR}` unresolved.
 */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.DATABASE_MCP_ENV_FILE?.trim();
    return override ? resolveUserPath(override) : resolveProjectPath(".env");
}

/** Convenience wrapper used by the loader. */
export function fileExists(path: string): boolean {
    return existsSync(path);
}
