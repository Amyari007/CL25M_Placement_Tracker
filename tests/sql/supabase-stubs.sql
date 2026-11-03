-- Minimal stand-ins for the Supabase platform objects the migrations use.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
-- Like Supabase: new public tables and functions are granted to the API
-- roles by default, so migrations must revoke explicitly.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, last_sign_in_at timestamptz);
create table auth.sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  refreshed_at timestamp without time zone);
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
-- Test convenience: every user starts with one sign-in session whose id
-- equals the user id (tests put the same value in the session_id claim).
create function auth.users_default_session() returns trigger language plpgsql as $$
begin insert into auth.sessions (id, user_id) values (new.id, new.id) on conflict do nothing; return new; end $$;
create trigger users_default_session after insert on auth.users for each row execute function auth.users_default_session();
grant usage on schema auth, extensions, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
