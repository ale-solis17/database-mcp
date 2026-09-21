-- ============================================================================
-- Dedicated READ-ONLY role for the Database MCP Server (PostgreSQL)
-- ============================================================================
-- Run this ONCE PER DATABASE you expose as a profile, as a superuser or the
-- database owner, CONNECTED TO THAT DATABASE.
--
-- Replace the placeholders:
--   change_me_strong_password -> a strong password
--   your_database             -> the target database name
--
-- Cluster-wide vs per-database (this matters once you have several profiles):
--   * Steps 1 and 4 are CLUSTER-wide. Running them again for a second database
--     on the SAME server is a no-op — which is why step 1 is guarded.
--   * Steps 2 and 3 are PER DATABASE and must run while connected to it.
--
--   Two profiles on the same server  -> one role, one password, two GRANT
--                                       CONNECTs (run steps 2-3 in each).
--   Two profiles on different servers -> two independent roles, two passwords,
--                                       two ${VAR} entries in .env.
--
-- The MCP server should ALWAYS connect with this role, never with your
-- application/owner user. This is the last line of defense: even if the MCP
-- layer had a bug, this role physically cannot modify data.
--
-- Tip: `npm run setup` writes a filled-in copy of this script per profile,
-- with the real database name and a freshly generated password, whenever it
-- finds a user that is not read-only.
-- ============================================================================

-- 1. Create the login role (CLUSTER-wide; skipped if it already exists, so
--    adding a second database on the same server is safe).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change_me_strong_password';
  END IF;
END $$;

-- 2. Allow connecting to this database. (PER DATABASE.)
GRANT CONNECT ON DATABASE your_database TO mcp_readonly;

-- 3. Grant read access to ALL data across EVERY schema (current and future).
--    pg_read_all_data is a predefined role (PostgreSQL 14+) that grants SELECT
--    on every table/view/sequence and USAGE on every schema — no per-schema or
--    per-tenant grants needed, and new tables are covered automatically.
--    (PER DATABASE.)
GRANT pg_read_all_data TO mcp_readonly;

-- 4. Belt-and-suspenders: force EVERY transaction from this role to be
--    read-only at the server level (PostgreSQL 14+). (CLUSTER-wide.)
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;

-- Notes:
-- * The MCP only INSPECTS function/procedure definitions; it never executes
--   them, so no EXECUTE grants are required.
-- * Verify every configured profile with:  npm run verify-permissions
--   (or a single one with:  npm run verify-permissions -- --profile=<name>)
--
-- ----------------------------------------------------------------------------
-- PostgreSQL < 14 (no pg_read_all_data): grant per schema instead of step 3.
-- Repeat this block for each schema you want to expose:
--
--   GRANT USAGE ON SCHEMA public TO mcp_readonly;
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
-- ----------------------------------------------------------------------------
