import dotenv from "dotenv";
import { envFilePath } from "./paths.js";

/**
 * Loads the `.env` file into `process.env`, once per process.
 *
 * Its own module because two independent entry points need it: `env.ts` for the
 * global settings, and `databases.ts` for the `${VAR}` secrets that profiles
 * reference. The standalone scripts (healthcheck, verify-permissions) import
 * only the latter, so hanging this off `env.ts` would leave them with an
 * unloaded .env and every `${VAR}` unresolved.
 *
 * An explicit path rather than `dotenv/config`: that reads `process.cwd()/.env`,
 * and an MCP client spawns us from an arbitrary directory, so it would silently
 * load nothing. Variables already set in the real environment always win —
 * dotenv never overrides them.
 */
let loaded = false;

export function loadEnvFile(): void {
    if (loaded) return;
    loaded = true;
    dotenv.config({ path: envFilePath(), quiet: true });
}
