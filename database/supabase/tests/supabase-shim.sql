-- Test-only stand-in for the parts of Supabase that migrations rely on, so the SQL can be tested
-- on plain Postgres (PGlite). It mirrors Supabase's roles, the auth schema, auth.uid(), and
-- Supabase's permissive default privileges, so a test passes only if our migrations remove them.
-- It is NOT a migration and must never run against a real Supabase project.

create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;

create schema auth;
create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text,
  -- as in Supabase: written only with the secret key (Auth admin API), never by the signed-in user
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  -- as in Supabase: editable by the signed-in user themselves
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth   to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant all on auth.users to service_role;

-- Supabase's defaults for objects created by the migration role (postgres)
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
