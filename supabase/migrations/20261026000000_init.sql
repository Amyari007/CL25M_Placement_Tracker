-- =====================================================================
-- CL25M Placement Tracker - schema, access control and login logic
-- Target: Supabase (PostgreSQL 15+)
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Private schema: never exposed through the API. Holds credentials,
-- login attempts and settings.
create schema if not exists private;
revoke all on schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema private from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
create type public.application_stage as enum (
  'applied',
  'assessment_scheduled',
  'interview',
  'offer_received',
  'rejected',
  'withdrawn'
);

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.students (
  id                   uuid primary key default gen_random_uuid(),
  roll_number          text not null unique
                         check (roll_number ~ '^CL25M0(0[1-9]|1[0-6])$' and roll_number <> 'CL25M014'),
  name                 text check (name is null or char_length(name) between 1 and 120),
  user_id              uuid unique references auth.users (id) on delete set null,
  profile_completed_at timestamptz,
  last_activity_at     timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table public.applications (
  id                      uuid primary key default gen_random_uuid(),
  student_id              uuid not null references public.students (id) on delete cascade,
  company_name            text not null check (char_length(company_name) between 1 and 120),
  normalized_company_name text generated always as (lower(company_name)) stored,
  role                    text check (role is null or char_length(role) between 1 and 120),
  application_stage       public.application_stage not null default 'applied',
  stage_is_default        boolean not null default true,
  test_date               date check (test_date is null or test_date between date '2020-01-01' and date '2035-12-31'),
  notes                   text check (notes is null or char_length(notes) <= 2000),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index applications_student_id_idx on public.applications (student_id);
create index applications_company_idx    on public.applications (normalized_company_name);
create index applications_test_date_idx  on public.applications (test_date);

-- Administrators (separate from students; never counted as a student)
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Hashed access codes. Plaintext is never stored.
create table private.student_credentials (
  student_id   uuid primary key references public.students (id) on delete cascade,
  code_hash    text not null,
  is_prototype boolean not null default true,
  rotated_at   timestamptz not null default now()
);

create table private.login_attempts (
  id           bigint generated always as identity primary key,
  roll_number  text not null,
  ip           text not null,
  outcome      text not null check (outcome in ('success', 'failure', 'throttled')),
  attempted_at timestamptz not null default now()
);
create index login_attempts_roll_idx on private.login_attempts (roll_number, attempted_at desc);
create index login_attempts_ip_idx   on private.login_attempts (ip, attempted_at desc);

create table private.settings (
  id                    boolean primary key default true check (id),
  require_admin_mfa     boolean not null default false,
  max_failures_per_roll int not null default 5,
  max_failures_per_ip   int not null default 30,
  lockout_minutes       int not null default 15
);
insert into private.settings default values;

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

-- Collapses inner whitespace and trims; keeps the student's casing.
create function public.clean_text(t text) returns text
language sql immutable as $$
  select nullif(regexp_replace(btrim(t), '\s+', ' ', 'g'), '')
$$;

-- Administrator check. If the admin has a verified MFA factor (or MFA is
-- required globally), the session must be at AAL2.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
     and (
       coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
       or (
         not (select s.require_admin_mfa from private.settings s)
         and not exists (
           select 1 from auth.mfa_factors f
           where f.user_id = auth.uid() and f.status = 'verified'
         )
       )
     )
$$;

create function public.my_student_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id from public.students s where s.user_id = auth.uid()
$$;

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
create function private.students_before_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.name := public.clean_text(new.name);
  if tg_op = 'UPDATE' then
    if new.name is distinct from old.name then
      new.updated_at := now();
      new.last_activity_at := now();
      if new.name is not null and old.profile_completed_at is null then
        new.profile_completed_at := now();
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger students_before_write before insert or update on public.students
  for each row execute function private.students_before_write();

create function private.applications_before_write() returns trigger
language plpgsql set search_path = '' as $$
declare n int;
begin
  new.company_name := public.clean_text(new.company_name);
  new.role  := public.clean_text(new.role);
  new.notes := nullif(btrim(new.notes), '');
  if new.company_name is null then
    raise exception 'Company name is required' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    select count(*) into n from public.applications where student_id = new.student_id;
    if n >= 300 then
      raise exception 'Application limit reached' using errcode = '23514';
    end if;
  else
    if new.student_id <> old.student_id then
      raise exception 'Applications cannot be moved between students' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger applications_before_write before insert or update on public.applications
  for each row execute function private.applications_before_write();

-- Keeps students.last_activity_at accurate (including deletions).
create function private.applications_touch_student() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.students set last_activity_at = now()
   where id = coalesce(new.student_id, old.student_id);
  return null;
end $$;
create trigger applications_touch_student after insert or update or delete on public.applications
  for each row execute function private.applications_touch_student();

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.students     enable row level security;
alter table public.applications enable row level security;
alter table public.admins       enable row level security;
alter table private.student_credentials enable row level security;
alter table private.login_attempts      enable row level security;
alter table private.settings            enable row level security;

-- students: own row or admin. Students may change only their name.
create policy students_select on public.students for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy students_update_own on public.students for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- applications: students own CRUD; admin read-only across the batch.
create policy applications_select on public.applications for select to authenticated
  using (student_id = (select public.my_student_id()) or (select public.is_admin()));
create policy applications_insert_own on public.applications for insert to authenticated
  with check (student_id = (select public.my_student_id()));
create policy applications_update_own on public.applications for update to authenticated
  using (student_id = (select public.my_student_id()))
  with check (student_id = (select public.my_student_id()));
create policy applications_delete_own on public.applications for delete to authenticated
  using (student_id = (select public.my_student_id()));

-- admins: a user can see only whether they themselves are listed.
create policy admins_select_self on public.admins for select to authenticated
  using (user_id = (select auth.uid()));

-- Table and column privileges (defence in depth on top of RLS)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.students, public.applications, public.admins from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.students, public.applications, public.admins from authenticated';
    execute 'grant select on public.students, public.applications, public.admins to authenticated';
    execute 'grant update (name) on public.students to authenticated';
    execute 'grant insert (student_id, company_name, role, application_stage, stage_is_default, test_date, notes) on public.applications to authenticated';
    execute 'grant update (company_name, role, application_stage, stage_is_default, test_date, notes) on public.applications to authenticated';
    execute 'grant delete on public.applications to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Server-only functions (service_role)
-- ---------------------------------------------------------------------

-- Verifies a roll number + access code with throttling.
-- Unknown roll numbers and wrong codes return the same 'invalid' status.
create function public.attempt_student_login(p_roll text, p_code text, p_ip text)
returns table (status text, student_id uuid, user_id uuid, retry_after_seconds int)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_roll text := upper(btrim(coalesce(p_roll, '')));
  v_ip   text := coalesce(nullif(btrim(p_ip), ''), 'unknown');
  cfg    private.settings;
  v_window_start timestamptz;
  v_last_success timestamptz;
  v_fail_roll int;
  v_fail_ip   int;
  v_oldest    timestamptz;
  v_student   public.students;
  v_hash      text;
begin
  select * into cfg from private.settings;
  v_window_start := now() - make_interval(mins => cfg.lockout_minutes);

  select max(a.attempted_at) into v_last_success
    from private.login_attempts a where a.roll_number = v_roll and a.outcome = 'success';

  select count(*), min(a.attempted_at) into v_fail_roll, v_oldest
    from private.login_attempts a
   where a.roll_number = v_roll and a.outcome = 'failure'
     and a.attempted_at > greatest(v_window_start, coalesce(v_last_success, '-infinity'));

  select count(*) into v_fail_ip
    from private.login_attempts a
   where a.ip = v_ip and a.outcome in ('failure', 'throttled') and a.attempted_at > v_window_start;

  if v_fail_roll >= cfg.max_failures_per_roll or v_fail_ip >= cfg.max_failures_per_ip then
    insert into private.login_attempts (roll_number, ip, outcome) values (v_roll, v_ip, 'throttled');
    return query select 'throttled'::text, null::uuid, null::uuid,
      greatest(1, ceil(extract(epoch from (coalesce(v_oldest, now()) + make_interval(mins => cfg.lockout_minutes) - now())))::int);
    return;
  end if;

  select * into v_student from public.students s where s.roll_number = v_roll;
  select c.code_hash into v_hash from private.student_credentials c where c.student_id = v_student.id;

  if v_student.id is null or v_hash is null
     or v_hash <> extensions.crypt(coalesce(p_code, ''), v_hash) then
    insert into private.login_attempts (roll_number, ip, outcome) values (v_roll, v_ip, 'failure');
    return query select 'invalid'::text, null::uuid, null::uuid, null::int;
    return;
  end if;

  insert into private.login_attempts (roll_number, ip, outcome) values (v_roll, v_ip, 'success');
  return query select 'ok'::text, v_student.id, v_student.user_id, null::int;
end $$;

-- Links a student row to its auth user (first login only).
create function public.link_student_user(p_student_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_existing uuid;
begin
  select user_id into v_existing from public.students where id = p_student_id for update;
  if v_existing is not null and v_existing <> p_user_id then
    raise exception 'Student already linked to another account';
  end if;
  update public.students set user_id = p_user_id where id = p_student_id;
end $$;

-- Sets a new hashed access code (rotation / recovery).
create function public.set_student_code(p_student_id uuid, p_code text, p_is_prototype boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_code !~ '^[0-9]{4,12}$' then
    raise exception 'Access code must be 4-12 digits';
  end if;
  insert into private.student_credentials (student_id, code_hash, is_prototype, rotated_at)
  values (p_student_id, extensions.crypt(p_code, extensions.gen_salt('bf', 10)), p_is_prototype, now())
  on conflict (student_id) do update
    set code_hash = excluded.code_hash, is_prototype = excluded.is_prototype, rotated_at = now();
  -- Clear lockouts for this roll number after an admin-assisted reset.
  delete from private.login_attempts a
   using public.students s
   where s.id = p_student_id and a.roll_number = s.roll_number and a.outcome <> 'success';
end $$;

-- Signs a user out everywhere (used after code rotation).
create function public.revoke_user_sessions(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.sessions where user_id = p_user_id;
end $$;

-- Credential status for the admin screen (never returns hashes).
create function public.admin_credential_status()
returns table (student_id uuid, roll_number text, has_code boolean, is_prototype boolean, rotated_at timestamptz, linked boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select s.id, s.roll_number, c.student_id is not null, coalesce(c.is_prototype, false), c.rotated_at, s.user_id is not null
      from public.students s left join private.student_credentials c on c.student_id = s.id
     order by s.roll_number;
end $$;

-- Function privileges
revoke all on function public.attempt_student_login(text, text, text) from public;
revoke all on function public.link_student_user(uuid, uuid) from public;
revoke all on function public.set_student_code(uuid, text, boolean) from public;
revoke all on function public.revoke_user_sessions(uuid) from public;
revoke all on function public.admin_credential_status() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.my_student_id() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.attempt_student_login(text, text, text), public.link_student_user(uuid, uuid), public.set_student_code(uuid, text, boolean), public.revoke_user_sessions(uuid), public.admin_credential_status(), public.is_admin(), public.my_student_id() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.attempt_student_login(text, text, text), public.link_student_user(uuid, uuid), public.set_student_code(uuid, text, boolean), public.revoke_user_sessions(uuid) from authenticated';
    execute 'grant execute on function public.is_admin(), public.my_student_id(), public.admin_credential_status() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.attempt_student_login(text, text, text), public.link_student_user(uuid, uuid), public.set_student_code(uuid, text, boolean), public.revoke_user_sessions(uuid) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Seed: exactly 15 authorized roll numbers (no names, no applications)
-- ---------------------------------------------------------------------
insert into public.students (roll_number) values
  ('CL25M001'), ('CL25M002'), ('CL25M003'), ('CL25M004'), ('CL25M005'),
  ('CL25M006'), ('CL25M007'), ('CL25M008'), ('CL25M009'), ('CL25M010'),
  ('CL25M011'), ('CL25M012'), ('CL25M013'), ('CL25M015'), ('CL25M016');

-- Live dashboard updates (Supabase Realtime respects the RLS policies above).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.applications, public.students;
  end if;
end $$;
