-- Works whether or not "Automatically expose new tables" was enabled:
-- explicit privileges for the server (service_role) and the schema itself.
-- Browser roles keep only the narrow grants made in earlier migrations.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all on all tables in schema public to service_role';
    execute 'grant execute on all functions in schema public to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema public to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant usage on schema public to anon';
  end if;
end $$;
