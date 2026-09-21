import { PostgresAdapter } from "./postgres/postgres.adapter.js";
import { isImplementedEngine } from "../config/databases.js";
import type { DatabaseAdapter } from "./database.adapter.js";
import type {
    DatabaseOverview,
    ProfileConfig,
    ProfilesConfig,
    QueryLimits,
    QueryResultData,
    RelationshipInfo,
    RoutineInfo,
    SchemaInfo,
    TableDescription,
    TableInfo,
    ViewInfo,
} from "../types/database.types.js";

/**
 * Resolves a profile name to a database adapter.
 *
 * Adapters are created LAZILY and are never connectivity-checked up front.
 * Eagerly opening every pool would mean an MCP client waiting on N round-trips
 * at spawn time (a sleeping Neon branch takes seconds), and — worse — a single
 * unreachable database would take the whole server down with it, losing access
 * to the healthy ones. `pg.Pool` does not connect until its first query anyway,
 * so constructing an adapter is just an allocation; connection failures surface
 * per tool call, attached to the profile that failed, which is exactly the
 * granularity the model needs to decide "try the other database instead".
 */

export type ProfileStatus =
    | { state: "idle" }
    | { state: "ok"; since: string }
    | { state: "error"; message: string };

export class UnknownProfileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnknownProfileError";
    }
}

export class UnsupportedEngineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UnsupportedEngineError";
    }
}

export interface ConnectionRegistry {
    /** Adapter for a profile, created on first use. Omit for the default. */
    get(profile?: string): DatabaseAdapter;
    readonly defaultProfile: string;
    readonly profiles: readonly ProfileConfig[];
    /** Last known connection state, for `list_databases`. */
    statusOf(name: string): ProfileStatus;
    /** Closes every pool that was actually opened. Never rejects. */
    closeAll(): Promise<void>;
}

export function createRegistry(config: ProfilesConfig): ConnectionRegistry {
    return new Registry(config);
}

class Registry implements ConnectionRegistry {
    readonly defaultProfile: string;
    readonly profiles: readonly ProfileConfig[];

    private readonly byName = new Map<string, ProfileConfig>();
    private readonly adapters = new Map<string, DatabaseAdapter>();
    private readonly status = new Map<string, ProfileStatus>();

    constructor(config: ProfilesConfig) {
        this.defaultProfile = config.defaultProfile;
        this.profiles = config.profiles;
        for (const profile of config.profiles) {
            this.byName.set(profile.name, profile);
            this.status.set(profile.name, { state: "idle" });
        }
    }

    get(profile?: string): DatabaseAdapter {
        const name = profile ?? this.defaultProfile;

        const existing = this.adapters.get(name);
        if (existing) return existing;

        const config = this.byName.get(name);
        if (!config) throw new UnknownProfileError(this.unknownProfileMessage(name));

        if (!isImplementedEngine(config.config.type)) {
            throw new UnsupportedEngineError(
                `Profile "${name}" uses engine "${config.config.type}", which is not implemented yet. ` +
                    "Supported today: postgres.",
            );
        }

        const adapter = new TrackedAdapter(new PostgresAdapter(config.config), name, this.status);
        this.adapters.set(name, adapter);
        return adapter;
    }

    statusOf(name: string): ProfileStatus {
        return this.status.get(name) ?? { state: "idle" };
    }

    async closeAll(): Promise<void> {
        // Only adapters that were actually created — never instantiate one just
        // to close it, which would open a pool during shutdown.
        await Promise.allSettled([...this.adapters.values()].map((a) => a.close()));
    }

    private unknownProfileMessage(name: string): string {
        const listed = this.profiles
            .map((p) => (p.name === this.defaultProfile ? `${p.name} (default)` : p.name))
            .join(", ");
        return (
            `Unknown database profile "${name}".\n` +
            `Configured profiles: ${listed}.\n` +
            "Call list_databases to see them with descriptions, or omit the \"profile\" " +
            `argument to use the default (${this.defaultProfile}).`
        );
    }
}

/**
 * Forwards every adapter call and records whether it succeeded, so
 * `list_databases` can report which databases are actually reachable.
 *
 * A failing profile is never evicted or blacklisted: `pg.Pool` recovers on its
 * own, and caching "this one is dead" would require a server restart after the
 * database comes back. Only the status string is remembered, and it is
 * refreshed by the next success.
 */
class TrackedAdapter implements DatabaseAdapter {
    constructor(
        private readonly inner: DatabaseAdapter,
        private readonly profile: string,
        private readonly status: Map<string, ProfileStatus>,
    ) {}

    private async track<T>(operation: () => Promise<T>): Promise<T> {
        try {
            const result = await operation();
            this.status.set(this.profile, { state: "ok", since: new Date().toISOString() });
            return result;
        } catch (err) {
            this.status.set(this.profile, {
                state: "error",
                message: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }

    testConnection(): Promise<boolean> {
        return this.track(() => this.inner.testConnection());
    }
    executeSelect(query: string, limits: QueryLimits): Promise<QueryResultData> {
        return this.track(() => this.inner.executeSelect(query, limits));
    }
    listSchemas(): Promise<SchemaInfo[]> {
        return this.track(() => this.inner.listSchemas());
    }
    listTables(schema?: string): Promise<TableInfo[]> {
        return this.track(() => this.inner.listTables(schema));
    }
    describeTable(schema: string, table: string): Promise<TableDescription> {
        return this.track(() => this.inner.describeTable(schema, table));
    }
    getTableDDL(schema: string, table: string): Promise<string> {
        return this.track(() => this.inner.getTableDDL(schema, table));
    }
    getRelationships(schema?: string): Promise<RelationshipInfo[]> {
        return this.track(() => this.inner.getRelationships(schema));
    }
    listViews(schema?: string): Promise<ViewInfo[]> {
        return this.track(() => this.inner.listViews(schema));
    }
    getViewDefinition(schema: string, view: string): Promise<string> {
        return this.track(() => this.inner.getViewDefinition(schema, view));
    }
    listProcedures(schema?: string): Promise<RoutineInfo[]> {
        return this.track(() => this.inner.listProcedures(schema));
    }
    getProcedureDefinition(schema: string, name: string): Promise<string> {
        return this.track(() => this.inner.getProcedureDefinition(schema, name));
    }
    getDatabaseOverview(): Promise<DatabaseOverview> {
        return this.track(() => this.inner.getDatabaseOverview());
    }
    /** Not tracked: closing is not a health signal. */
    close(): Promise<void> {
        return this.inner.close();
    }
}
