import { Pool } from "pg";
import { DatabaseAdapter } from "../database.adapter.js";
import { logger } from "../../logger.js";
import type {
    DatabaseConfig,
    DatabaseOverview,
    QueryLimits,
    QueryResultData,
    RelationshipInfo,
    RoutineInfo,
    SchemaInfo,
    TableDescription,
    TableInfo,
    ViewInfo,
} from "../../types/database.types.js";

const NOT_IMPLEMENTED = "Not implemented yet";

export class PostgresAdapter implements DatabaseAdapter {
    private readonly pool: Pool;

    constructor(private readonly dbConfig: DatabaseConfig) {
        this.pool = new Pool({
            host: dbConfig.host,
            port: dbConfig.port,
            database: dbConfig.database,
            user: dbConfig.user,
            password: dbConfig.password,
            ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
            application_name: "database-mcp",
            // Keep the pool small: this is a read-only inspection tool, not an app backend.
            max: 5,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        });

        // Surface pool-level errors on idle clients instead of crashing the process.
        this.pool.on("error", (err) => {
            logger.error("Unexpected PostgreSQL pool error", { error: err.message });
        });
    }

    async testConnection(): Promise<boolean> {
        try {
            const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
            return result.rows[0]?.ok === 1;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Do NOT leak connection strings / credentials in the error.
            throw new Error(`Database connection failed: ${message}`);
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    // ── Metadata & queries ────────────────────────────────────────────────

    async executeSelect(query: string, limits: QueryLimits): Promise<QueryResultData> {
        const cleaned = query.replace(/;\s*$/, "");
        // Row cap enforced in SQL: fetch one extra row to detect truncation.
        const wrapped = `SELECT * FROM (${cleaned}) AS _mcp_sub LIMIT ${limits.maxRows + 1}`;

        const client = await this.pool.connect();
        try {
            // Layer C: PostgreSQL itself refuses any write inside this transaction.
            await client.query("BEGIN TRANSACTION READ ONLY");
            await client.query(`SET LOCAL statement_timeout = ${Math.floor(limits.queryTimeoutMs)}`);

            const result = await client.query(wrapped);
            const truncated = result.rows.length > limits.maxRows;
            const rows = truncated ? result.rows.slice(0, limits.maxRows) : result.rows;

            // Enforce the response-size limit to avoid flooding the AI context.
            const serialized = JSON.stringify(rows);
            const sizeMb = Buffer.byteLength(serialized, "utf8") / (1024 * 1024);
            if (sizeMb > limits.maxResultSizeMb) {
                throw new Error(
                    `Result too large (${sizeMb.toFixed(1)} MB > ${limits.maxResultSizeMb} MB limit). ` +
                        "Add a tighter LIMIT or select fewer columns.",
                );
            }

            const columns = result.fields.map((f) => f.name);
            return { columns, rows, rowCount: rows.length, truncated };
        } finally {
            // Always end the transaction; ignore rollback errors on a dead conn.
            await client.query("ROLLBACK").catch(() => undefined);
            client.release();
        }
    }

    async listSchemas(): Promise<SchemaInfo[]> {
        const { rows } = await this.pool.query<{ name: string }>(
            `SELECT schema_name AS name
               FROM information_schema.schemata
              WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
                AND schema_name NOT LIKE 'pg_%'
              ORDER BY schema_name`,
        );
        return rows.map((r) => ({ name: r.name }));
    }

    async listTables(schema?: string): Promise<TableInfo[]> {
        const { rows } = await this.pool.query<{
            schema: string;
            name: string;
            comment: string | null;
        }>(
            `SELECT n.nspname AS schema,
                    c.relname AS name,
                    obj_description(c.oid) AS comment
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg_%'
                AND ($1::text IS NULL OR n.nspname = $1)
              ORDER BY n.nspname, c.relname`,
            [schema ?? null],
        );
        return rows.map((r) => ({
            schema: r.schema,
            name: r.name,
            type: "table",
            comment: r.comment,
        }));
    }

    /** Resolves a schema.table pair to its pg_class OID, or throws "Table not found". */
    private async resolveTableOid(schema: string, table: string): Promise<number> {
        const { rows } = await this.pool.query<{ oid: number }>(
            `SELECT c.oid
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2
                AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
            [schema, table],
        );
        const oid = rows[0]?.oid;
        if (oid === undefined) {
            throw new Error(`Table not found: ${schema}.${table}`);
        }
        return oid;
    }

    async describeTable(schema: string, table: string): Promise<TableDescription> {
        const oid = await this.resolveTableOid(schema, table);

        const [columns, comment, indexes, foreignKeys] = await Promise.all([
            this.pool.query<{
                name: string;
                data_type: string;
                nullable: boolean;
                default: string | null;
                position: number;
                comment: string | null;
            }>(
                `SELECT a.attname AS name,
                        format_type(a.atttypid, a.atttypmod) AS data_type,
                        NOT a.attnotnull AS nullable,
                        pg_get_expr(d.adbin, d.adrelid) AS default,
                        a.attnum AS position,
                        col_description(a.attrelid, a.attnum) AS comment
                   FROM pg_attribute a
                   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
                  ORDER BY a.attnum`,
                [oid],
            ),
            this.pool.query<{ comment: string | null }>(
                `SELECT obj_description($1) AS comment`,
                [oid],
            ),
            this.pool.query<{
                name: string;
                unique: boolean;
                primary: boolean;
                definition: string;
                columns: string[];
            }>(
                `SELECT i.relname AS name,
                        ix.indisunique AS unique,
                        ix.indisprimary AS primary,
                        pg_get_indexdef(ix.indexrelid) AS definition,
                        array_agg(a.attname::text ORDER BY k.ord) AS columns
                   FROM pg_index ix
                   JOIN pg_class i ON i.oid = ix.indexrelid
                   JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
                   JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
                  WHERE ix.indrelid = $1
                  GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indexrelid
                  ORDER BY ix.indisprimary DESC, i.relname`,
                [oid],
            ),
            this.pool.query<{
                constraint_name: string;
                columns: string[];
                ref_schema: string;
                ref_table: string;
                ref_columns: string[];
            }>(
                `SELECT con.conname AS constraint_name,
                        (SELECT array_agg(att.attname::text ORDER BY u.ord)
                           FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord)
                           JOIN pg_attribute att ON att.attrelid = con.conrelid
                                                AND att.attnum = u.attnum) AS columns,
                        fn.nspname AS ref_schema,
                        fc.relname AS ref_table,
                        (SELECT array_agg(att.attname::text ORDER BY u.ord)
                           FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord)
                           JOIN pg_attribute att ON att.attrelid = con.confrelid
                                                AND att.attnum = u.attnum) AS ref_columns
                   FROM pg_constraint con
                   JOIN pg_class fc ON fc.oid = con.confrelid
                   JOIN pg_namespace fn ON fn.oid = fc.relnamespace
                  WHERE con.conrelid = $1 AND con.contype = 'f'
                  ORDER BY con.conname`,
                [oid],
            ),
        ]);

        const primaryIndex = indexes.rows.find((i) => i.primary);

        return {
            schema,
            table,
            comment: comment.rows[0]?.comment ?? null,
            columns: columns.rows.map((c) => ({
                name: c.name,
                dataType: c.data_type,
                nullable: c.nullable,
                default: c.default,
                position: c.position,
                comment: c.comment,
            })),
            primaryKey: primaryIndex
                ? { constraintName: primaryIndex.name, columns: primaryIndex.columns }
                : null,
            foreignKeys: foreignKeys.rows.map((f) => ({
                constraintName: f.constraint_name,
                columns: f.columns,
                referencedSchema: f.ref_schema,
                referencedTable: f.ref_table,
                referencedColumns: f.ref_columns,
            })),
            indexes: indexes.rows.map((i) => ({
                name: i.name,
                columns: i.columns,
                unique: i.unique,
                primary: i.primary,
                definition: i.definition,
            })),
        };
    }

    /**
     * PostgreSQL has no built-in "get CREATE TABLE" function, so we reconstruct
     * an equivalent DDL representation from the table description.
     */
    async getTableDDL(schema: string, table: string): Promise<string> {
        const d = await this.describeTable(schema, table);
        const ident = `"${schema}"."${table}"`;
        const lines: string[] = [];

        for (const c of d.columns) {
            let line = `    "${c.name}" ${c.dataType}`;
            if (!c.nullable) line += " NOT NULL";
            if (c.default !== null) line += ` DEFAULT ${c.default}`;
            lines.push(line);
        }
        if (d.primaryKey) {
            lines.push(
                `    CONSTRAINT "${d.primaryKey.constraintName}" PRIMARY KEY (${d.primaryKey.columns
                    .map((c) => `"${c}"`)
                    .join(", ")})`,
            );
        }
        for (const fk of d.foreignKeys) {
            lines.push(
                `    CONSTRAINT "${fk.constraintName}" FOREIGN KEY (${fk.columns
                    .map((c) => `"${c}"`)
                    .join(", ")}) REFERENCES "${fk.referencedSchema}"."${fk.referencedTable}" (${fk.referencedColumns
                    .map((c) => `"${c}"`)
                    .join(", ")})`,
            );
        }

        let ddl = `CREATE TABLE ${ident} (\n${lines.join(",\n")}\n);`;

        // Append non-primary indexes (pg_get_indexdef gives full statements).
        const extraIndexes = d.indexes.filter((i) => !i.primary && i.definition);
        for (const idx of extraIndexes) {
            ddl += `\n${idx.definition};`;
        }

        // Comments.
        if (d.comment) {
            ddl += `\nCOMMENT ON TABLE ${ident} IS ${quoteLiteral(d.comment)};`;
        }
        for (const c of d.columns) {
            if (c.comment) {
                ddl += `\nCOMMENT ON COLUMN ${ident}."${c.name}" IS ${quoteLiteral(c.comment)};`;
            }
        }

        return ddl;
    }

    async getRelationships(schema?: string): Promise<RelationshipInfo[]> {
        const { rows } = await this.pool.query<{
            constraint_name: string;
            from_schema: string;
            from_table: string;
            from_columns: string[];
            to_schema: string;
            to_table: string;
            to_columns: string[];
        }>(
            `SELECT con.conname AS constraint_name,
                    fn.nspname AS from_schema,
                    fc.relname AS from_table,
                    (SELECT array_agg(att.attname::text ORDER BY u.ord)
                       FROM unnest(con.conkey) WITH ORDINALITY u(attnum, ord)
                       JOIN pg_attribute att ON att.attrelid = con.conrelid
                                            AND att.attnum = u.attnum) AS from_columns,
                    tn.nspname AS to_schema,
                    tc.relname AS to_table,
                    (SELECT array_agg(att.attname::text ORDER BY u.ord)
                       FROM unnest(con.confkey) WITH ORDINALITY u(attnum, ord)
                       JOIN pg_attribute att ON att.attrelid = con.confrelid
                                            AND att.attnum = u.attnum) AS to_columns
               FROM pg_constraint con
               JOIN pg_class fc ON fc.oid = con.conrelid
               JOIN pg_namespace fn ON fn.oid = fc.relnamespace
               JOIN pg_class tc ON tc.oid = con.confrelid
               JOIN pg_namespace tn ON tn.oid = tc.relnamespace
              WHERE con.contype = 'f'
                AND fn.nspname NOT IN ('pg_catalog', 'information_schema')
                AND fn.nspname NOT LIKE 'pg_%'
                AND ($1::text IS NULL OR fn.nspname = $1)
              ORDER BY fn.nspname, fc.relname, con.conname`,
            [schema ?? null],
        );
        return rows.map((r) => ({
            constraintName: r.constraint_name,
            fromSchema: r.from_schema,
            fromTable: r.from_table,
            fromColumns: r.from_columns,
            toSchema: r.to_schema,
            toTable: r.to_table,
            toColumns: r.to_columns,
        }));
    }

    async listViews(schema?: string): Promise<ViewInfo[]> {
        const { rows } = await this.pool.query<{
            schema: string;
            name: string;
            type: string;
        }>(
            `SELECT n.nspname AS schema,
                    c.relname AS name,
                    CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' END AS type
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('v', 'm')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg_%'
                AND ($1::text IS NULL OR n.nspname = $1)
              ORDER BY n.nspname, c.relname`,
            [schema ?? null],
        );
        return rows.map((r) => ({ schema: r.schema, name: r.name, type: r.type }));
    }

    async getViewDefinition(schema: string, view: string): Promise<string> {
        const { rows } = await this.pool.query<{ def: string }>(
            `SELECT pg_get_viewdef(c.oid, true) AS def
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')`,
            [schema, view],
        );
        const def = rows[0]?.def;
        if (def === undefined) {
            throw new Error(`View not found: ${schema}.${view}`);
        }
        return def;
    }

    async listProcedures(schema?: string): Promise<RoutineInfo[]> {
        const { rows } = await this.pool.query<{
            schema: string;
            name: string;
            kind: string;
            return_type: string | null;
            arguments: string;
            language: string;
        }>(
            `SELECT n.nspname AS schema,
                    p.proname AS name,
                    CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                    CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END AS return_type,
                    pg_get_function_arguments(p.oid) AS arguments,
                    l.lanname AS language
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               JOIN pg_language l ON l.oid = p.prolang
              WHERE p.prokind IN ('f', 'p')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg_%'
                AND NOT EXISTS (
                    SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
                )
                AND ($1::text IS NULL OR n.nspname = $1)
              ORDER BY n.nspname, p.proname`,
            [schema ?? null],
        );
        return rows.map((r) => ({
            schema: r.schema,
            name: r.name,
            kind: r.kind,
            returnType: r.return_type,
            arguments: r.arguments,
            language: r.language,
        }));
    }

    /**
     * Returns the source definition(s) for INSPECTION only — the routine is
     * never executed. Overloaded names return all matching signatures.
     */
    async getProcedureDefinition(schema: string, name: string): Promise<string> {
        const { rows } = await this.pool.query<{ def: string }>(
            `SELECT pg_get_functiondef(p.oid) AS def
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('f', 'p')
              ORDER BY p.oid`,
            [schema, name],
        );
        if (rows.length === 0) {
            throw new Error(`Procedure/function not found: ${schema}.${name}`);
        }
        return rows.map((r) => r.def).join("\n\n");
    }

    async getDatabaseOverview(): Promise<DatabaseOverview> {
        const MAX_TABLES = 500;
        const MAX_COLUMNS_PER_TABLE = 50;

        const [tableCols, viewCounts, routineCounts, relationships] = await Promise.all([
            this.pool.query<{ schema: string; table: string; columns: string[] }>(
                `SELECT n.nspname AS schema,
                        c.relname AS "table",
                        array_agg(a.attname::text ORDER BY a.attnum) AS columns
                   FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                  WHERE c.relkind IN ('r', 'p')
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                    AND n.nspname NOT LIKE 'pg_%'
                  GROUP BY n.nspname, c.relname
                  ORDER BY n.nspname, c.relname`,
            ),
            this.pool.query<{ schema: string; count: string }>(
                `SELECT n.nspname AS schema, count(*)::text AS count
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relkind IN ('v', 'm')
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                    AND n.nspname NOT LIKE 'pg_%'
                  GROUP BY n.nspname`,
            ),
            this.pool.query<{ schema: string; count: string }>(
                `SELECT n.nspname AS schema, count(*)::text AS count
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE p.prokind IN ('f', 'p')
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                    AND n.nspname NOT LIKE 'pg_%'
                    AND NOT EXISTS (
                        SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
                    )
                  GROUP BY n.nspname`,
            ),
            this.getRelationships(),
        ]);

        const viewMap = new Map(viewCounts.rows.map((r) => [r.schema, Number(r.count)]));
        const routineMap = new Map(routineCounts.rows.map((r) => [r.schema, Number(r.count)]));

        // Group tables by schema, applying compactness caps.
        let truncated = false;
        const schemaMap = new Map<string, { name: string; columns: string[] }[]>();
        let totalTables = 0;
        for (const row of tableCols.rows) {
            if (totalTables >= MAX_TABLES) {
                truncated = true;
                break;
            }
            totalTables += 1;
            const cols = row.columns.slice(0, MAX_COLUMNS_PER_TABLE);
            if (cols.length < row.columns.length) truncated = true;
            const list = schemaMap.get(row.schema) ?? [];
            list.push({ name: row.table, columns: cols });
            schemaMap.set(row.schema, list);
        }

        const schemas = (await this.listSchemas()).map((s) => {
            const tables = schemaMap.get(s.name) ?? [];
            return {
                name: s.name,
                tableCount: tables.length,
                viewCount: viewMap.get(s.name) ?? 0,
                routineCount: routineMap.get(s.name) ?? 0,
                tables,
            };
        });

        return {
            database: this.dbConfig.database,
            schemas,
            relationships,
            truncated,
        };
    }
}

/** Escapes a string as a PostgreSQL single-quoted literal for DDL output. */
function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
