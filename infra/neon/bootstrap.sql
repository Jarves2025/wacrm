-- ============================================================
-- Neon bootstrap for the self-hosted Supabase services.
--
-- Hosted Supabase ships a Postgres image that already contains the
-- roles, schemas and publication below. Neon is plain Postgres, so we
-- create them once, BEFORE the auth (GoTrue) and storage services boot
-- (they run their own migrations into the `auth` / `storage` schemas)
-- and BEFORE `supabase/migrations/*` are applied.
--
-- Run it with:  node scripts/neon-setup.mjs bootstrap
-- The script substitutes the __*_PASSWORD__ placeholders from env.
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- API roles used by PostgREST / RLS -------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  -- GoTrue's and storage-api's own migrations grant to `postgres` when it
  -- exists, as on hosted Supabase. NOLOGIN stand-in; it owns nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN;
  END IF;
  -- Referenced by Realtime's tenant migrations (GRANT/REVOKE ... dashboard_user,
  -- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin). NOLOGIN stand-ins.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_user') THEN
    CREATE ROLE dashboard_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE;
  END IF;
  -- Realtime's tenant migrations move ownership of realtime.* to this
  -- role; the database owner must be a member for that to be allowed.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin NOINHERIT NOLOGIN NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
    CREATE ROLE supabase_storage_admin LOGIN NOINHERIT CREATEROLE;
  END IF;
END
$$;

ALTER ROLE authenticator          WITH LOGIN PASSWORD '__AUTHENTICATOR_PASSWORD__';
ALTER ROLE supabase_auth_admin    WITH LOGIN PASSWORD '__AUTH_ADMIN_PASSWORD__';
ALTER ROLE supabase_storage_admin WITH LOGIN PASSWORD '__STORAGE_ADMIN_PASSWORD__';

GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO supabase_storage_admin;

-- The database owner (the role Neon gives you, e.g. neondb_owner) applies
-- the app migrations, which add triggers on auth.users and policies on
-- storage.objects. Membership makes that legal.
--
-- Hosted Supabase has a `postgres` superuser that owns the SECURITY
-- DEFINER functions (`OWNER TO postgres` in the migrations). Neon has
-- none; scripts/neon-setup.mjs rewrites those lines to OWNER TO
-- CURRENT_USER, i.e. the database owner, which has BYPASSRLS and owns
-- the tables — the two things those functions rely on.
DO $$
BEGIN
  EXECUTE format('GRANT supabase_auth_admin, supabase_storage_admin, supabase_realtime_admin, supabase_admin, service_role, authenticated, anon TO %I', current_user);
END
$$;

-- ---------- Schemas ---------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS _realtime;
CREATE SCHEMA IF NOT EXISTS realtime;

ALTER ROLE supabase_auth_admin    SET search_path = auth;
ALTER ROLE supabase_storage_admin SET search_path = storage;
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO supabase_auth_admin, supabase_storage_admin', current_database());
END
$$;

-- GoTrue's migrations live in the `auth` schema but some of them
-- reference public/extensions objects.
GRANT USAGE ON SCHEMA public, extensions TO supabase_auth_admin, supabase_storage_admin;

-- ---------- Extensions ------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------- API grants on public --------------------------------
GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth    TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES  TO anon, authenticated, service_role;

-- PostgREST exposes the `public` schema only.
ALTER ROLE authenticator SET statement_timeout = '8s';

-- ---------- Realtime --------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;
