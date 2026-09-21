/**
 * Argument parsing for the standalone scripts (healthcheck, verify-permissions).
 *
 * These run outside MCP, so they cannot take a `profile` tool argument; they
 * take it on the command line instead.
 */

export interface ProfileArgs {
    /** A single profile to act on. */
    profile?: string;
    /** Act on every configured profile. */
    all: boolean;
    help: boolean;
}

export class ArgError extends Error {}

export function parseProfileArgs(argv: string[]): ProfileArgs {
    const args: ProfileArgs = { all: false, help: false };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;

        if (arg === "--all") {
            args.all = true;
        } else if (arg === "-h" || arg === "--help") {
            args.help = true;
        } else if (arg.startsWith("--profile=")) {
            args.profile = arg.slice("--profile=".length);
        } else if (arg === "--profile") {
            const value = argv[++i];
            if (value === undefined || value.startsWith("-")) {
                throw new ArgError("--profile requires a profile name, e.g. --profile=main");
            }
            args.profile = value;
        } else {
            throw new ArgError(`Unknown argument "${arg}".`);
        }
    }

    if (args.all && args.profile !== undefined) {
        throw new ArgError("--all and --profile are mutually exclusive.");
    }
    if (args.profile !== undefined && args.profile.trim() === "") {
        throw new ArgError("--profile requires a profile name, e.g. --profile=main");
    }

    return args;
}

export function usage(command: string, defaultBehaviour: string): string {
    return [
        `Usage: node ${command} [--profile=<name> | --all]`,
        "",
        `  (no arguments)     ${defaultBehaviour}`,
        "  --profile=<name>   act on that profile only",
        "  --all              act on every configured profile",
        "  -h, --help         show this message",
    ].join("\n");
}
