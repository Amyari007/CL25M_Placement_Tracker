-- =====================================================================
-- Coordinators:
--  1. "All companies" option. The administrator can let a coordinator see
--     roll-number lists for every company (stored as the assignment '*').
--  2. Upcoming assessments listed per application (date, company, stage),
--     soonest first. Still no names or roll numbers in that list.
-- Safe to run more than once. Deletes no data.
-- =====================================================================

-- '*' = all companies (current and future).
create or replace function private.company_assigned(p_uid uuid, p_company text) returns boolean
language sql stable security definer set search_path = '' as $$
  with req as (select private.group_of(public.company_key(p_company)) as g)
  select public.company_key(p_company) <> '' and exists (
    select 1 from private.coordinator_companies c, req
     where c.user_id = p_uid
       and (c.company_key = '*'
            or c.company_key = req.g or private.group_of(c.company_key) = req.g or public.same_company_key(c.company_key, req.g))
  )
$$;

create or replace function public.admin_coordinator_assign(p_user_id uuid, p_companies text[])
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_name text; v_key text; v_keys text[] := '{}';
begin
  perform private.require_admin();
  if not exists (select 1 from public.team_members t where t.user_id = p_user_id) then
    raise exception 'Unknown coordinator' using errcode = 'P0002';
  end if;
  if coalesce(array_length(p_companies, 1), 0) > 100 then
    raise exception 'At most 100 companies per coordinator' using errcode = '22023';
  end if;
  foreach v_name in array coalesce(p_companies, '{}') loop
    v_name := public.clean_text(v_name);
    continue when v_name is null;
    if char_length(v_name) > 120 then raise exception 'Company names must be 120 characters or fewer' using errcode = '22023'; end if;
    if v_name = '*' or lower(v_name) = 'all companies' then
      v_key := '*';
      v_name := 'All companies';
    else
      v_key := public.company_key(v_name);
    end if;
    continue when v_key = '' or v_key = any (v_keys);
    v_keys := v_keys || v_key;
    insert into private.coordinator_companies (user_id, company_key, display_name, assigned_by)
    values (p_user_id, v_key, v_name, auth.uid())
    on conflict (user_id, company_key) do update set display_name = excluded.display_name;
  end loop;
  delete from private.coordinator_companies where user_id = p_user_id and company_key <> all (v_keys);
  perform private.admin_audit('admin.companies_assigned', p_user_id, jsonb_build_object('companies', to_jsonb(v_keys)));
end $$;

create or replace function public.svc_coord_dashboard(ctx jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_reason text;
  v_stats jsonb;
  v_stages jsonb;
  v_upcoming jsonb;
  v_companies jsonb;
  v_total int;
  v_all boolean;
begin
  v_reason := private.coord_gate(ctx, 'dashboard', null);
  if v_reason is not null then return jsonb_build_object('ok', false, 'reason', v_reason); end if;

  select count(*) into v_total from public.students;
  v_all := exists (select 1 from private.coordinator_companies c where c.user_id = v_uid and c.company_key = '*');

  create temp table if not exists coord_dash_names (group_key text primary key, company text, students int) on commit drop;
  truncate pg_temp.coord_dash_names;
  with g as (select * from private.company_groups()),
  rel as (select a.student_id, a.company_name, a.created_at, g.group_key
            from public.applications a join g on g.company_key = a.company_key),
  per as (select rel.group_key, count(distinct rel.student_id)::int as n from rel group by rel.group_key),
  spelling as (
    select distinct on (x.group_key) x.group_key, x.company_name
      from (select rel.group_key, rel.company_name, count(*) as uses, min(rel.created_at) as first_at
              from rel group by rel.group_key, rel.company_name) x
     order by x.group_key, x.uses desc, (x.company_name ~ '[A-Z]') desc, x.first_at asc)
  insert into pg_temp.coord_dash_names (group_key, company, students)
  select per.group_key, sp.company_name, per.n from per join spelling sp using (group_key);

  select coalesce(jsonb_agg(jsonb_build_object('company_key', n.group_key, 'company', n.company, 'students', n.students)
                            order by n.students desc, n.company), '[]'::jsonb)
    into v_stats from pg_temp.coord_dash_names n;

  select coalesce(jsonb_agg(jsonb_build_object('stage', x.application_stage, 'count', x.n) order by x.application_stage), '[]'::jsonb)
    into v_stages
    from (select a.application_stage, count(*)::int as n from public.applications a group by a.application_stage) x;

  -- Upcoming assessments, one line per application: date, company, stage.
  -- No names or roll numbers.
  select coalesce(jsonb_agg(jsonb_build_object('company_key', x.group_key, 'company', x.company, 'date', x.test_date, 'stage', x.application_stage)
                            order by x.test_date, x.company, x.application_stage), '[]'::jsonb)
    into v_upcoming
    from (select private.group_of(a.company_key) as group_key,
                 coalesce(n.company, a.company_name) as company, a.test_date, a.application_stage
            from public.applications a
            left join pg_temp.coord_dash_names n on n.group_key = private.group_of(a.company_key)
           where a.test_date between current_date and current_date + 45
             and a.application_stage not in ('rejected', 'withdrawn')) x;

  if v_all then
    select coalesce(jsonb_agg(jsonb_build_object(
             'company_key', n.group_key, 'company', n.company, 'applicants', n.students,
             'outreach', (select to_jsonb(o) - 'updated_by' from private.company_outreach o where o.company_key = n.group_key)
           ) order by n.company), '[]'::jsonb)
      into v_companies from pg_temp.coord_dash_names n;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'company_key', c.company_key,
             'company', c.display_name,
             'applicants', (select count(distinct a.student_id) from public.applications a
                             where private.group_of(a.company_key) = private.group_of(c.company_key)),
             'outreach', (select to_jsonb(o) - 'updated_by' from private.company_outreach o where o.company_key = c.company_key)
           ) order by c.display_name), '[]'::jsonb)
      into v_companies
      from private.coordinator_companies c where c.user_id = v_uid;
  end if;

  perform private.audit(v_uid, 'coordinator', 'coord.dashboard', 'success', null, null,
                        private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req');
  return jsonb_build_object('ok', true, 'total_students', v_total, 'stats', v_stats, 'stages', v_stages,
                            'upcoming', v_upcoming, 'companies', v_companies, 'all_companies', v_all, 'refreshed_at', now());
end $$;

create or replace function public.svc_coord_outreach_update(ctx jsonb, p_company text, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_key text := public.company_key(left(coalesce(p_company, ''), 120));
  v_reason text;
  v_display text;
  v_row jsonb;
begin
  if v_key = '' then return jsonb_build_object('ok', false, 'reason', 'company'); end if;
  v_reason := private.coord_gate(ctx, 'outreach', v_key);
  if v_reason is not null then return jsonb_build_object('ok', false, 'reason', v_reason); end if;
  -- Records are kept under the assignment's key (or the company's group key
  -- for an "all companies" coordinator) so admin and coordinator share one row.
  select c.company_key, c.display_name into v_key, v_display from private.coordinator_companies c
   where c.user_id = v_uid and c.company_key <> '*'
     and (c.company_key = v_key or private.group_of(c.company_key) = private.group_of(v_key))
   limit 1;
  if v_key is null then
    v_key := private.group_of(public.company_key(left(p_company, 120)));
    v_display := public.clean_text(left(p_company, 120));
  end if;
  begin
    v_row := private.outreach_upsert(v_uid, v_key, v_display, p_fields);
  exception when check_violation or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
    perform private.audit(v_uid, 'coordinator', 'coord.outreach', 'failure', v_key, null,
                          private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req',
                          jsonb_build_object('reason', 'invalid'));
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end;
  perform private.audit(v_uid, 'coordinator', 'coord.outreach', 'success', v_key, null,
                        private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req',
                        jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_fields) k)));
  return jsonb_build_object('ok', true, 'outreach', v_row);
end $$;

-- The '*' assignment is not a company: keep it out of the outreach list.
create or replace function public.admin_outreach()
returns table (company_key text, company text, outreach_status text, recruitment_stage text, last_contact date,
               next_action text, next_action_date date, assessment_date date, updated_at timestamptz,
               updated_by_email text, coordinators jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
  with keys as (
    select o.company_key, o.display_name from private.company_outreach o
    union
    select c.company_key, min(c.display_name) from private.coordinator_companies c where c.company_key <> '*' group by c.company_key
  ), k as (select distinct on (keys.company_key) keys.company_key, keys.display_name from keys order by keys.company_key)
  select k.company_key, coalesce(o.display_name, k.display_name),
         coalesce(o.outreach_status, 'not_started'), coalesce(o.recruitment_stage, 'not_open'),
         o.last_contact, o.next_action, o.next_action_date, o.assessment_date, o.updated_at, u.email::text,
         coalesce((select jsonb_agg(t.email order by t.email) from private.coordinator_companies c
                    join public.team_members t on t.user_id = c.user_id
                   where c.company_key = k.company_key or c.company_key = '*'), '[]'::jsonb)
    from k left join private.company_outreach o on o.company_key = k.company_key
    left join auth.users u on u.id = o.updated_by
   order by 2;
end $$;

revoke all on all functions in schema private from public;

-- Check: assignments per coordinator ('All companies' = every company)
select t.email, coalesce(string_agg(c.display_name, ', ' order by c.display_name), '(none)') as companies
  from public.team_members t left join private.coordinator_companies c on c.user_id = t.user_id
 group by t.email order by t.email;
