-- =====================================================================
-- Placement-team members must not see student names.
-- Safe to run on the live project: it changes permissions only and
-- deletes no data.
--
-- How: the browser role may read every students column EXCEPT name.
-- Names are then available only through two functions:
--   my_profile()          -> a student's own name
--   admin_student_names() -> all names, administrator only
-- A team member asking for names directly gets "permission denied".
-- =====================================================================

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke select on public.students from authenticated';
    execute 'grant select (id, roll_number, user_id, profile_completed_at, last_activity_at, submitted_at, created_at, updated_at) on public.students to authenticated';
  end if;
end $$;

-- A student's own name (empty result for anyone who is not a student).
create or replace function public.my_profile()
returns table (name text)
language sql stable security definer set search_path = '' as $$
  select s.name from public.students s where s.user_id = auth.uid()
$$;

-- Every student's name: the administrator only (never team members).
create or replace function public.admin_student_names()
returns table (student_id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query select s.id, s.name from public.students s order by s.roll_number;
end $$;

revoke all on function public.my_profile(), public.admin_student_names() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.my_profile(), public.admin_student_names() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_profile(), public.admin_student_names() to authenticated';
  end if;
end $$;

-- Live-update messages carry whole rows; stop sending students rows so a
-- team member's browser never receives a name that way. The admin
-- dashboard still refreshes on application changes and every 60 seconds.
do $$ begin
  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'students') then
    alter publication supabase_realtime drop table public.students;
  end if;
end $$;

-- Check: should list the columns the browser may read (no "name").
select column_name from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'students'
   and grantee = 'authenticated' and privilege_type = 'SELECT'
 order by 1;
