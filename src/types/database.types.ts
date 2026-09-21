/**
 * Engine-agnostic database metadata types.
 *
 * These types describe the *shape* of information the MCP layer works with,
 * independent of any specific database engine. Each DatabaseAdapter is
 * responsible for mapping its engine's native metadata into these structures.
 */

/** Supported database engines. Only "postgres" is implemented today. */
export type DatabaseType = "postgres" | "mysql" | "sqlserver";

/** Connection parameters for a single database. */
export interface DatabaseConfig {
    type: DatabaseType;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    /** Optional SSL toggle. Many managed providers (e.g. Neon) require it. */
    ssl?: boolean;
}

/**
 * A named database this server can query.
 *
 * One process serves many: tools take an optional `profile` argument naming
 * one of these, and fall back to the default when it is omitted.
 */
export interface ProfileConfig {
    name: string;
    /** Human-readable note surfaced to the AI by `list_databases`. */
    description?: string;
    config: DatabaseConfig;
}

/** The whole databases.json, resolved and validated. */
export interface ProfilesConfig {
    defaultProfile: string;
    /** Ordered, default first, so `list_databases` output is stable. */
    profiles: ProfileConfig[];
    /** Absolute path the config was loaded from, for logs and error messages. */
    sourcePath: string;
}

/** Safety limits applied to query execution. */
export interface QueryLimits {
    /** Hard cap on rows returned to the AI. */
    maxRows: number;
    /** Per-query timeout in milliseconds. */
    queryTimeoutMs: number;
    /** Maximum serialized result size in megabytes. */
    maxResultSizeMb: number;
}

/** A schema + table pair. */
export interface TableRef {
    schema: string;
    table: string;
}

export interface SchemaInfo {
    name: string;
}

export interface TableInfo {
    schema: string;
    name: string;
    /** "table" | "view" etc. Engine-specific values are normalized where possible. */
    type: string;
    comment?: string | null;
}

export interface ColumnInfo {
    name: string;
    dataType: string;
    nullable: boolean;
    default: string | null;
    /** Ordinal position within the table (1-based). */
    position: number;
    comment?: string | null;
}

export interface PrimaryKeyInfo {
    constraintName: string;
    columns: string[];
}

export interface ForeignKeyInfo {
    constraintName: string;
    columns: string[];
    referencedSchema: string;
    referencedTable: string;
    referencedColumns: string[];
}

export interface IndexInfo {
    name: string;
    columns: string[];
    unique: boolean;
    primary: boolean;
    definition?: string;
}

export interface TableDescription {
    schema: string;
    table: string;
    comment?: string | null;
    columns: ColumnInfo[];
    primaryKey: PrimaryKeyInfo | null;
    foreignKeys: ForeignKeyInfo[];
    indexes: IndexInfo[];
}

export interface RelationshipInfo {
    constraintName: string;
    fromSchema: string;
    fromTable: string;
    fromColumns: string[];
    toSchema: string;
    toTable: string;
    toColumns: string[];
}

export interface ViewInfo {
    schema: string;
    name: string;
    /** "view" | "materialized view" */
    type: string;
}

/** A stored routine. In PostgreSQL this distinguishes functions from procedures. */
export interface RoutineInfo {
    schema: string;
    name: string;
    /** "function" | "procedure" */
    kind: string;
    /** Return type for functions; null for procedures. */
    returnType: string | null;
    /** Human-readable argument signature, e.g. "(a integer, b text)". */
    arguments: string;
    language?: string;
}

/** Structured result of a SELECT query. */
export interface QueryResultData {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    /** True when the result was truncated by maxRows. */
    truncated: boolean;
}

/** Compact, high-level snapshot of a database for AI context. */
export interface DatabaseOverview {
    database: string;
    schemas: {
        name: string;
        tableCount: number;
        viewCount: number;
        routineCount: number;
        tables: {
            name: string;
            columns: string[];
        }[];
    }[];
    relationships: RelationshipInfo[];
    /** Set when data was capped to keep the overview compact. */
    truncated: boolean;
}
