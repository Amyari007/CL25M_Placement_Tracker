-- =====================================================================
-- Feature update: explicit submissions, aggregate-only student stats,
-- spelling-tolerant company matching, and approved placement-team access.
-- Builds on 20261026000000_init.sql (nothing there is dropped).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Company matching (mirrors supabase/functions/_shared/analytics.ts)
-- ---------------------------------------------------------------------

-- Comparison key: case, spacing, punctuation, accents and trailing legal
-- words ("Pvt Ltd", "India") removed. "Commotion Pvt. Ltd." -> 'commotion'.
create function public.company_key(p text) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  s text;
  w text[];
  suffixes text[] := array['pvt','private','ltd','limited','llp','llc','inc','incorporated','corp','corporation',
                           'co','company','plc','gmbh','ag','sa','bv','india','technologies','technology','tech'];
begin
  s := lower(normalize(coalesce(p, ''), NFKD));
  -- (accents split off by NFKD are removed with all other non a-z/0-9 characters below)
  s := replace(s, '&', ' and ');
  s := btrim(regexp_replace(s, '[^a-z0-9]+', ' ', 'g'));
  if s = '' then return ''; end if;
  w := string_to_array(s, ' ');
  while array_length(w, 1) > 1 and w[array_length(w, 1)] = any (suffixes) loop
    w := w[1:array_length(w, 1) - 1];
  end loop;
  return array_to_string(w, '');
end $$;

-- Damerau-Levenshtein (optimal string alignment) distance.
create function public.osa_distance(a text, b text) returns int
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  m int := length(a);
  n int := length(b);
  w int := length(b) + 1;
  d int[];
  i int;
  j int;
  c int;
  v int;
begin
  if a = b then return 0; end if;
  if m = 0 then return n; end if;
  if n = 0 then return m; end if;
  d := array_fill(0, array[(m + 1) * (n + 1)]);
  for i in 0..m loop d[i * w + 1] := i; end loop;
  for j in 0..n loop d[j + 1] := j; end loop;
  for i in 1..m loop
    for j in 1..n loop
      c := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      v := least(d[(i - 1) * w + j + 1] + 1, d[i * w + j] + 1, d[(i - 1) * w + j] + c);
      if i > 1 and j > 1 and substr(a, i, 1) = substr(b, j - 1, 1) and substr(a, i - 1, 1) = substr(b, j, 1) then
        v := least(v, d[(i - 2) * w + j - 1] + 1);
      end if;
      d[i * w + j + 1] := v;
    end loop;
  end loop;
  return d[m * w + n + 1];
end $$;

-- Same company? Exact key, or a small typo: none for names <= 4 letters,
-- 1 up to 8, 2 beyond. First letter and all digits must match.
create function public.same_company_key(ka text, kb text) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select ka = kb or (
    ka <> '' and kb <> ''
    and left(ka, 1) = left(kb, 1)
    and regexp_replace(ka, '\D', '', 'g') = regexp_replace(kb, '\D', '', 'g')
    and public.osa_distance(ka, kb) <= case
          when least(length(ka), length(kb)) <= 4 then 0
          when least(length(ka), length(kb)) <= 8 then 1
          else 2 end
  )
$$;

-- ---------------------------------------------------------------------
-- 2. One entry per student per company
-- ---------------------------------------------------------------------
alter table public.applications
  add column company_key text generated always as (public.company_key(company_name)) stored;

-- If earlier data has duplicates for the same student and company, keep the
-- most recently updated one (needed before the unique index can exist).
delete from public.applications a
 using public.applications b
 where a.student_id = b.student_id
   and a.company_key = b.company_key
   and (a.updated_at, a.id) < (b.updated_at, b.id);

create unique index applications_student_company_uidx on public.applications (student_id, company_key);
create index applications_company_key_idx on public.applications (company_key);

alter table public.applications add constraint applications_company_key_nonempty check (company_key <> '');

alter table public.students add column submitted_at timestamptz;

-- ---------------------------------------------------------------------
-- 3. Placement-team members (approved and revocable by the administrator)
-- ---------------------------------------------------------------------
create table public.team_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table public.team_members enable row level security;
create policy team_members_select_self on public.team_members for select to authenticated
  using (user_id = (select auth.uid()));

-- MFA rule shared by admin and team: once a user has a verified factor
-- (or MFA is required globally) their session must be AAL2.
create function private.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or (
        not (select s.require_admin_mfa from private.settings s)
        and not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
      )
$$;

-- Administrator OR active (not revoked) team member.
create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or (
        exists (select 1 from public.team_members t where t.user_id = auth.uid() and t.revoked_at is null)
        and private.mfa_ok()
      )
$$;

-- Applicant identities: admin and approved team members (was admin only).
drop policy students_select on public.students;
create policy students_select on public.students for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff()));
drop policy applications_select on public.applications;
create policy applications_select on public.applications for select to authenticated
  using (student_id = (select public.my_student_id()) or (select public.is_staff()));

-- Students now write only through submit_applications() (validated,
-- transactional). Direct table writes are removed.
drop policy applications_insert_own on public.applications;
drop policy applications_update_own on public.applications;
drop policy applications_delete_own on public.applications;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on public.applications from authenticated';
    execute 'revoke all on public.team_members from authenticated';
    execute 'grant select on public.team_members to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.team_members from anon';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Explicit submission
-- ---------------------------------------------------------------------
-- p_items: the student's complete list, e.g.
--   [{"company_name":"Commotion","test_date":"2026-11-02","role":null,
--     "application_stage":"applied","stage_is_default":true,"notes":null}]
-- Replaces the student's list in one transaction. Resubmitting the same list
-- changes nothing; a student can never hold the same company twice.
create function public.submit_applications(p_items jsonb)
returns setof public.applications
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sid   uuid := public.my_student_id();
  v_prev  timestamptz;
  v_item  jsonb;
  v_name  text;
  v_key   text;
  v_keys  text[] := '{}';
  v_names text[] := '{}';
  i int;
begin
  if v_sid is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Invalid submission' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 300 then
    raise exception 'Too many companies (maximum 300)' using errcode = '22023';
  end if;

  -- Serialize submissions from the same student (two tabs, double taps).
  select submitted_at into v_prev from public.students where id = v_sid for update;

  if jsonb_array_length(p_items) = 0 and v_prev is null then
    raise exception 'Add at least one company before submitting' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid submission' using errcode = '22023';
    end if;
    v_name := public.clean_text(v_item ->> 'company_name');
    if v_name is null then
      raise exception 'Every entry needs a company name' using errcode = '22023';
    end if;
    if char_length(v_name) > 120 then
      raise exception 'Company names must be 120 characters or fewer' using errcode = '22023';
    end if;
    v_key := public.company_key(v_name);
    if v_key = '' then
      raise exception '"%" is not a valid company name', v_name using errcode = '22023';
    end if;
    for i in 1..coalesce(array_length(v_keys, 1), 0) loop
      if public.same_company_key(v_keys[i], v_key) then
        raise exception '"%" and "%" look like the same company - keep one', v_names[i], v_name using errcode = '23505';
      end if;
    end loop;
    v_keys := v_keys || v_key;
    v_names := v_names || v_name;
  end loop;

  -- Remove companies no longer in the list.
  delete from public.applications a
   where a.student_id = v_sid and a.company_key <> all (v_keys);

  -- Add new companies; update changed ones; leave identical ones untouched.
  insert into public.applications as a
         (student_id, company_name, role, application_stage, stage_is_default, test_date, notes)
  select v_sid, x.company_name, x.role,
         coalesce(x.application_stage, 'applied'), coalesce(x.stage_is_default, x.application_stage is null),
         x.test_date, x.notes
    from jsonb_to_recordset(p_items) as x (company_name text, role text, application_stage public.application_stage,
                                           stage_is_default boolean, test_date date, notes text)
  on conflict (student_id, company_key) do update
     set company_name = excluded.company_name,
         role = excluded.role,
         application_stage = excluded.application_stage,
         stage_is_default = excluded.stage_is_default,
         test_date = excluded.test_date,
         notes = excluded.notes
   where (a.company_name, a.role, a.application_stage, a.stage_is_default, a.test_date, a.notes)
         is distinct from
         (public.clean_text(excluded.company_name), public.clean_text(excluded.role), excluded.application_stage,
          excluded.stage_is_default, excluded.test_date, nullif(btrim(excluded.notes), ''));

  update public.students set submitted_at = now(), last_activity_at = now() where id = v_sid;

  return query select * from public.applications a where a.student_id = v_sid order by a.created_at;
end $$;

-- ---------------------------------------------------------------------
-- 5. Company groups (typo-tolerant clusters) and aggregate statistics
-- ---------------------------------------------------------------------
-- Each distinct key joins the first (most common) group it matches.
-- Same ordering as companyGroups() in analytics.ts.
create function private.company_groups()
returns table (company_key text, group_key text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  seeds text[] := '{}';
  hit text;
  s text;
begin
  for r in
    select a.company_key as k, count(*) as n, min(a.created_at) as first_at
      from public.applications a
     group by a.company_key
     order by n desc, first_at asc, k asc
  loop
    hit := null;
    foreach s in array seeds loop
      if public.same_company_key(s, r.k) then hit := s; exit; end if;
    end loop;
    if hit is null then
      seeds := seeds || r.k;
      hit := r.k;
    end if;
    company_key := r.k;
    group_key := hit;
    return next;
  end loop;
end $$;

-- Student-facing aggregate: company name, distinct students, percentage.
-- No ids, names or roll numbers ever leave this function.
-- Students see it after their first submission; staff always.
create function public.company_application_stats()
returns table (company text, students int, percent numeric, total_relationships int, refreshed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (
    public.is_staff()
    or exists (select 1 from public.students s where s.user_id = auth.uid() and s.submitted_at is not null)
  ) then
    raise exception 'Submit your applications to see batch statistics' using errcode = '42501';
  end if;

  return query
  with g as (select * from private.company_groups()),
  rel as (
    select a.student_id, a.company_name, a.created_at, g.group_key
      from public.applications a join g on g.company_key = a.company_key
  ),
  per as (
    select rel.group_key, count(distinct rel.student_id)::int as n from rel group by rel.group_key
  ),
  spelling as (
    select distinct on (x.group_key) x.group_key, x.company_name
      from (
        select rel.group_key, rel.company_name, count(*) as uses, min(rel.created_at) as first_at
          from rel group by rel.group_key, rel.company_name
      ) x
     order by x.group_key, x.uses desc, (x.company_name ~ '[A-Z]') desc, x.first_at asc
  ),
  tot as (select coalesce(sum(per.n), 0)::int as t from per)
  select sp.company_name, per.n,
         round(per.n * 100.0 / nullif(tot.t, 0), 1),
         tot.t, now()
    from per join spelling sp using (group_key) cross join tot
   order by per.n desc, sp.company_name asc;
end $$;

-- ---------------------------------------------------------------------
-- 6. Team management (administrator only)
-- ---------------------------------------------------------------------
create function public.admin_list_team()
returns table (user_id uuid, email text, granted_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query select t.user_id, t.email, t.granted_at, t.revoked_at from public.team_members t order by t.granted_at;
end $$;

create function public.admin_grant_team(p_email text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid; v_email text := lower(btrim(p_email));
begin
  if not public.is_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select u.id into v_uid from auth.users u where lower(u.email) = v_email;
  if v_uid is null then raise exception 'No account exists for %', v_email using errcode = 'P0002'; end if;
  if exists (select 1 from public.students s where s.user_id = v_uid) then
    raise exception 'Student accounts cannot be placement-team members' using errcode = '22023';
  end if;
  if exists (select 1 from public.admins a where a.user_id = v_uid) then
    raise exception 'That account is already the administrator' using errcode = '22023';
  end if;
  insert into public.team_members (user_id, email, granted_by)
  values (v_uid, v_email, auth.uid())
  on conflict (user_id) do update set revoked_at = null, granted_at = now(), granted_by = auth.uid(), email = excluded.email;
  return v_uid;
end $$;

create function public.admin_revoke_team(p_user_id uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  update public.team_members set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  delete from auth.sessions where user_id = p_user_id;  -- also end their sign-ins
end $$;

-- Server-only helper for the admin-team edge function.
create function public.find_user_id_by_email(p_email text)
returns uuid language sql stable security definer set search_path = '' as $$
  select u.id from auth.users u where lower(u.email) = lower(btrim(p_email))
$$;

-- ---------------------------------------------------------------------
-- 7. Function privileges
-- ---------------------------------------------------------------------
revoke all on function public.company_key(text), public.osa_distance(text, text), public.same_company_key(text, text) from public;
revoke all on function public.submit_applications(jsonb), public.company_application_stats(), public.is_staff(),
  public.admin_list_team(), public.admin_grant_team(text), public.admin_revoke_team(uuid), public.find_user_id_by_email(text) from public;
revoke all on function private.company_groups(), private.mfa_ok() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.company_key(text), public.osa_distance(text, text), public.same_company_key(text, text) to authenticated';
    execute 'grant execute on function public.submit_applications(jsonb), public.company_application_stats(), public.is_staff(), public.admin_list_team(), public.admin_grant_team(text), public.admin_revoke_team(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.find_user_id_by_email(text), public.company_key(text) to service_role';
  end if;
end $$;
