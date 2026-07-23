/**
 * Minimal structured logger.
 *
 * CRITICAL: the MCP protocol communicates over STDOUT via STDIO transport.
 * Writing logs to stdout would corrupt the protocol stream, so ALL log output
 * goes to STDERR. Never use console.log here.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configuredLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) ?? "info";
const threshold = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info;

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry = {
        level,
        message,
        ...(meta ? { meta } : {}),
    };
    // stderr only — see file header.
    process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
    debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
    info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
    error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
