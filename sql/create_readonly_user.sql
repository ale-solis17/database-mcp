-- ============================================================================
-- Dedicated READ-ONLY role for the Database MCP Server (PostgreSQL)
-- ============================================================================
-- Run this as a superuser or the database owner.
-- Replace the placeholders:
--   :password      -> a strong password
--   your_database  -> the target database name
--   public         -> repeat the per-schema block for every schema to expose
--
-- The MCP server should ALWAYS connect with this role, never with your
-- application/owner user. This is the last line of defense: even if the MCP
-- layer had a bug, this role physically cannot modify data.
-- ============================================================================

-- 1. Create the login role.
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change_me_strong_password';

-- 2. Allow connecting to the database.
GRANT CONNECT ON DATABASE your_database TO mcp_readonly;

-- 3. Per-schema read grants. Repeat this block for each schema you expose.
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mcp_readonly;

-- 4. Make future tables readable automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;

-- 5. Belt-and-suspenders: force EVERY transaction from this role to be
--    read-only at the server level (PostgreSQL 14+).
ALTER ROLE mcp_readonly SET default_transaction_read_only = on;

-- Notes:
-- * The MCP only INSPECTS function/procedure definitions; it never executes
--   them, so no EXECUTE grants are required.
-- * To expose additional schemas, copy step 3 and 4 replacing "public".
-- * Verify with:  npm run verify-permissions
