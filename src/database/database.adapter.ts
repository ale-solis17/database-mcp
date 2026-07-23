import type {
    DatabaseOverview,
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
 * Engine-agnostic contract the MCP layer depends on.
 *
 * The MCP tools NEVER contain engine-specific SQL — they call these methods.
 * Each concrete adapter (PostgresAdapter, future MySQLAdapter, ...) translates
 * them into engine-specific queries and maps results into the shared types.
 *
 * All methods are strictly read-only.
 */
export interface DatabaseAdapter {
    /** Verifies connectivity. Returns true on success, throws on failure. */
    testConnection(): Promise<boolean>;

    /**
     * Executes a read-only SELECT/WITH query. Implementations MUST enforce
     * read-only execution at the engine level (e.g. a READ ONLY transaction)
     * and apply the provided limits (row cap, timeout).
     */
    executeSelect(query: string, limits: QueryLimits): Promise<QueryResultData>;

    /** Lists user-visible schemas, excluding engine-internal system schemas. */
    listSchemas(): Promise<SchemaInfo[]>;

    /** Lists tables, optionally filtered to a single schema. */
    listTables(schema?: string): Promise<TableInfo[]>;

    /** Full description of one table: columns, PK, FKs, indexes, comment. */
    describeTable(schema: string, table: string): Promise<TableDescription>;

    /** DDL (or an equivalent representation) for a table. */
    getTableDDL(schema: string, table: string): Promise<string>;

    /** Foreign-key relationships, optionally filtered to a schema. */
    getRelationships(schema?: string): Promise<RelationshipInfo[]>;

    /** Lists views (and materialized views), optionally filtered to a schema. */
    listViews(schema?: string): Promise<ViewInfo[]>;

    /** Definition (SELECT body) of a view. */
    getViewDefinition(schema: string, view: string): Promise<string>;

    /** Lists stored functions and procedures, optionally filtered to a schema. */
    listProcedures(schema?: string): Promise<RoutineInfo[]>;

    /** Source definition of a function/procedure. Inspection only — never executed. */
    getProcedureDefinition(schema: string, name: string): Promise<string>;

    /** Compact, high-level overview of the database for AI context. */
    getDatabaseOverview(): Promise<DatabaseOverview>;

    /** Releases all resources (connection pool). */
    close(): Promise<void>;
}
