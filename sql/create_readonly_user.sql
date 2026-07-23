-- ============================================================================
-- Dedicated READ-ONLY role for the Database MCP Server (PostgreSQL)
-- ============================================================================
-- Run this as a superuser or the database owner.
-- Replace the placeholders:
--   change_me_strong_password -> a strong password
--   your_database             -> the target database name
--
-- The MCP server should ALWAYS connect with this role, never with your
-- application/owner user. This is the last line of defense: even if the MCP
-- layer had a bug, this role physically cannot modify data.
-- ============================================================================

-- 1. Create the login role.
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change_me_strong_password';

-- 2. Allow connecting to the database.
GRANT CONNECT ON DATABASE your_database TO mcp_readonly;

-- 3. Grant read access to ALL data across EVERY schema (current and future).
--    pg_read_all_data is a predefined role (PostgreSQL 14+) that grants SELECT
--    on every table/view/sequence and USAGE on every schema — no per-schema or
--    per-tenant grants needed, and new tables are covered automatically.
GRANT pg_read_all_data TO mcp_readonly;

-- 4. Belt-and-suspenders: force EVERY transaction from this role to be
--    read-only at the server level (PostgreSQL 14+).
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;

-- Notes:
-- * The MCP only INSPECTS function/procedure definitions; it never executes
--   them, so no EXECUTE grants are required.
-- * Verify with:  npm run verify-permissions
--
-- ----------------------------------------------------------------------------
-- PostgreSQL < 14 (no pg_read_all_data): grant per schema instead of step 3.
-- Repeat this block for each schema you want to expose:
--
--   GRANT USAGE ON SCHEMA public TO mcp_readonly;
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
-- ----------------------------------------------------------------------------
