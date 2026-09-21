import { ArgError, parseProfileArgs, usage } from "./cli-args.js";
import { ConfigError, getProfilesConfig } from "./config/databases.js";
import { createRegistry } from "./database/connection-registry.js";
import type { ProfileConfig } from "./types/database.types.js";

/**
 * Standalone connectivity check, also used by the Docker HEALTHCHECK.
 *
 * With no arguments it checks the DEFAULT profile only — deliberately, because
 * Docker restarts a container it considers unhealthy, and a secondary database
 * being asleep must not kill a server whose primary database is fine. Use
 * `--all` for the full check.
 *
 * Exit codes: 0 = reachable, 1 = anything else (including config errors).
 * Docker only distinguishes zero from non-zero, so no other code is invented.
 * Writes nothing to stdout.
 */
async function run(): Promise<void> {
    let args;
    try {
        args = parseProfileArgs(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(
            `${err instanceof ArgError ? err.message : String(err)}\n\n` +
                `${usage("dist/healthcheck.js", "check the default profile")}\n`,
        );
        process.exit(1);
    }

    if (args.help) {
        process.stderr.write(`${usage("dist/healthcheck.js", "check the default profile")}\n`);
        process.exit(0);
    }

    const config = getProfilesConfig();
    const registry = createRegistry(config);

    let targets: ProfileConfig[];
    if (args.all) {
        targets = [...config.profiles];
    } else {
        const name = args.profile ?? config.defaultProfile;
        const found = config.profiles.find((p) => p.name === name);
        if (!found) {
            const names = config.profiles.map((p) => p.name).join(", ");
            process.stderr.write(
                `Unknown database profile "${name}".\nConfigured profiles: ${names}.\n`,
            );
            process.exit(1);
        }
        targets = [found];
    }

    let failed = false;
    try {
        // Sequential: attributing a hang to a profile matters more than speed.
        for (const target of targets) {
            try {
                await registry.get(target.name).testConnection();
                if (args.all) process.stderr.write(`[${target.name}] ok\n`);
            } catch (err) {
                failed = true;
                const message = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[${target.name}] FAIL ${message}\n`);
            }
        }
    } finally {
        await registry.closeAll();
    }

    process.exit(failed ? 1 : 0);
}

run().catch((err) => {
    process.stderr.write(
        err instanceof ConfigError
            ? `\n${err.message}\n\n`
            : `healthcheck failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
});
