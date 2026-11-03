-- =====================================================================
-- Security hardening: restricted placement coordinators
--
--   * Coordinators lose ALL direct table access. Everything they see comes
--     from server functions (svc_*) that only the coordinator-api edge
--     function may call, after it has verified the caller's token, MFA
--     level and registered-device signature.
--   * Every svc_* call re-checks, inside the database: active coordinator,
--     not suspended, session still alive, AAL2, password rotated, active
--     registered device, company assignment and rate limits.
--   * One active registered device per coordinator; a replacement needs a
--     one-time approval from the primary administrator.
--   * Append-only audit log, alert rules, admin security functions.
--   * Administrator access now also requires the session to still exist,
--     so "sign everyone out" takes effect immediately for data access.
--
-- Requires: 20261027000000_hide_names_from_team.sql (run that first).
-- Safe on the live project: adds tables/functions, changes permissions,
-- deletes no student or application data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Small helpers
-- ---------------------------------------------------------------------
create or replace function private.jwt_session_id() returns uuid
language sql stable set search_path = '' as $$
  select case
           when (auth.jwt() ->> 'session_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then (auth.jwt() ->> 'session_id')::uuid
         end
$$;

create or replace function private.session_alive(p_uid uuid, p_sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_uid is not null and p_sid is not null
     and exists (select 1 from auth.sessions s where s.id = p_sid and s.user_id = p_uid)
$$;

-- Request metadata as reported by the Supabase API gateway (browser RPCs).
create or replace function private.req_header(p_name text) returns text
language plpgsql stable set search_path = '' as $$
declare h text := nullif(current_setting('request.headers', true), '');
begin
  if h is null then return null; end if;
  return nullif(left(h::json ->> p_name, 300), '');
exception when others then
  return null;
end $$;

create or replace function private.req_ip() returns text
language sql stable set search_path = '' as $$
  select coalesce(private.req_header('cf-connecting-ip'),
                  private.req_header('x-real-ip'),
                  nullif(btrim(split_part(coalesce(private.req_header('x-forwarded-for'), ''), ',', 1)), ''))
$$;

-- ---------------------------------------------------------------------
-- 1. Administrator: session must still exist (immediate sign-out effect)
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
     and private.session_alive(auth.uid(), private.jwt_session_id())
     and private.mfa_ok()
$$;

-- Coordinators are never "staff" for direct database reads any more.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
$$;

drop policy if exists students_select on public.students;
create policy students_select on public.students for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists applications_select on public.applications;
create policy applications_select on public.applications for select to authenticated
  using (student_id = (select public.my_student_id()) or (select public.is_admin()));

-- Server-only helper was executable by browser roles through Supabase's
-- default function privileges (account enumeration). Close it.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.find_user_id_by_email(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.find_user_id_by_email(text) from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Coordinator accounts (team_members keeps the role mapping)
-- ---------------------------------------------------------------------
-- Added once; re-running this file does not reset anyone's progress.
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'team_members' and column_name = 'must_change_password') then
    alter table public.team_members
      add column suspended_at         timestamptz,
      add column suspended_reason     text check (suspended_reason is null or char_length(suspended_reason) <= 300),
      add column must_change_password boolean not null default true,
      add column password_changed_at  timestamptz,
      add column credential_issued_at timestamptz;
    -- Any password issued before this migration is treated as exposed.
    update public.team_members set must_change_password = true, password_changed_at = null;
  end if;
end $$;

-- The browser may read only the caller's own row (policy from earlier) and
-- only these columns.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.team_members from authenticated';
    execute 'grant select (user_id, email, revoked_at, suspended_at, must_change_password) on public.team_members to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Private tables
-- ---------------------------------------------------------------------
alter table private.settings
  add column if not exists audit_retention_days          int not null default 180,
  add column if not exists replacement_window_hours      int not null default 48,
  add column if not exists rate_view_per_10min           int not null default 60,
  add column if not exists rate_export_per_hour          int not null default 10,
  add column if not exists rate_enroll_per_hour          int not null default 5,
  add column if not exists rate_password_per_hour        int not null default 5,
  add column if not exists rate_outreach_per_10min       int not null default 60,
  add column if not exists rate_dashboard_per_10min      int not null default 120,
  add column if not exists staff_login_fail_per_account  int not null default 5,
  add column if not exists staff_login_fail_per_ip       int not null default 30,
  add column if not exists staff_login_window_minutes    int not null default 15,
  add column if not exists alert_exports_per_10min       int not null default 3,
  add column if not exists alert_companies_per_hour      int not null default 6,
  add column if not exists alert_views_per_10min         int not null default 30,
  add column if not exists alert_denied_per_10min        int not null default 10,
  add column if not exists alert_login_fail_per_15min    int not null default 5,
  add column if not exists alert_enroll_denied_per_hour  int not null default 3,
  add column if not exists alert_device_changes_per_week int not null default 3;

create table if not exists private.coordinator_devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  public_key     jsonb not null,
  key_thumbprint text not null unique,
  label          text check (label is null or char_length(label) <= 80),
  user_agent     text,
  ip             text,
  status         text not null default 'active' check (status in ('active', 'revoked')),
  enrolled_at    timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_by     uuid,
  revoke_reason  text
);
create unique index if not exists coordinator_devices_one_active on private.coordinator_devices (user_id) where status = 'active';

create table if not exists private.device_replacement_grants (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  granted_by uuid not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reason     text,
  used_at    timestamptz
);

create table if not exists private.device_nonces (
  user_id uuid not null,
  nonce   text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, nonce)
);

create table if not exists private.coordinator_companies (
  user_id      uuid not null references auth.users (id) on delete cascade,
  company_key  text not null check (company_key <> ''),
  display_name text not null,
  assigned_by  uuid,
  assigned_at  timestamptz not null default now(),
  primary key (user_id, company_key)
);

create table if not exists private.company_outreach (
  company_key       text primary key check (company_key <> ''),
  display_name      text not null,
  outreach_status   text not null default 'not_started'
                      check (outreach_status in ('not_started', 'contacted', 'in_discussion', 'confirmed', 'on_hold', 'closed')),
  recruitment_stage text not null default 'not_open'
                      check (recruitment_stage in ('not_open', 'applications_open', 'assessment', 'interviews', 'offers', 'completed')),
  last_contact      date,
  next_action       text check (next_action is null or char_length(next_action) <= 300),
  next_action_date  date,
  assessment_date   date,
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);

create table if not exists private.audit_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_role  text not null,
  event_type  text not null,
  outcome     text not null check (outcome in ('success', 'denied', 'failure', 'error')),
  company_key text,
  target_id   uuid,
  device_id   uuid,
  ip          text,
  user_agent  text,
  request_id  text,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists audit_events_at_idx    on private.audit_events (at desc);
create index if not exists audit_events_actor_idx on private.audit_events (actor_id, at desc);
create index if not exists audit_events_type_idx  on private.audit_events (event_type, at desc);
create index if not exists audit_events_ip_idx    on private.audit_events (ip, at desc);

create table if not exists private.security_alerts (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  rule         text not null,
  severity     text not null check (severity in ('low', 'medium', 'high')),
  actor_id     uuid,
  subject      text,
  reason       text not null,
  occurrences  int not null default 1,
  status       text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  review_note  text
);
create index if not exists security_alerts_open_idx on private.security_alerts (status, created_at desc);

create table if not exists private.rate_events (
  bucket  text not null,
  subject text not null,
  at      timestamptz not null default now()
);
create index if not exists rate_events_idx on private.rate_events (bucket, subject, at desc);

alter table private.coordinator_devices       enable row level security;
alter table private.device_replacement_grants enable row level security;
alter table private.device_nonces             enable row level security;
alter table private.coordinator_companies     enable row level security;
alter table private.company_outreach          enable row level security;
alter table private.audit_events              enable row level security;
alter table private.security_alerts           enable row level security;
alter table private.rate_events               enable row level security;

-- No browser or server role touches these tables directly; only the
-- SECURITY DEFINER functions below (owned by the database owner) do.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on private.coordinator_devices, private.device_replacement_grants, private.device_nonces,
                      private.coordinator_companies, private.company_outreach, private.audit_events,
                      private.security_alerts, private.rate_events from %I', r);
    end if;
  end loop;
end $$;

-- Audit events are append-only. Only the retention routine may remove
-- events older than the retention period.
create or replace function private.audit_events_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and current_setting('cl25m.audit_retention', true) = 'on'
     and old.at < now() - make_interval(days => (select s.audit_retention_days from private.settings s)) then
    return old;
  end if;
  raise exception 'Audit events cannot be changed or deleted' using errcode = '42501';
end $$;
drop trigger if exists audit_events_no_change on private.audit_events;
create trigger audit_events_no_change before update or delete on private.audit_events
  for each row execute function private.audit_events_guard();

create or replace function private.audit_events_no_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Audit events cannot be truncated' using errcode = '42501';
end $$;
drop trigger if exists audit_events_no_truncate on private.audit_events;
create trigger audit_events_no_truncate before truncate on private.audit_events
  for each statement execute function private.audit_events_no_truncate();

-- ---------------------------------------------------------------------
-- 4. Rate limiting, alerts, audit
-- ---------------------------------------------------------------------
create or replace function private.rate_count(p_bucket text, p_subject text, p_window_s int) returns int
language sql stable set search_path = '' as $$
  select count(*)::int from private.rate_events e
   where e.bucket = p_bucket and e.subject = coalesce(p_subject, '?')
     and e.at > now() - make_interval(secs => p_window_s)
$$;

create or replace function private.rate_add(p_bucket text, p_subject text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  insert into private.rate_events (bucket, subject) values (p_bucket, coalesce(p_subject, '?'));
  if random() < 0.02 then
    delete from private.rate_events where at < now() - interval '2 days';
    delete from private.device_nonces where seen_at < now() - interval '10 minutes';
  end if;
end $$;

-- Counts this attempt, then answers whether it is within the limit.
-- Every attempt counts, so hammering keeps the caller blocked.
create or replace function private.rate_hit(p_bucket text, p_subject text, p_window_s int, p_max int) returns boolean
language plpgsql volatile set search_path = '' as $$
begin
  perform private.rate_add(p_bucket, p_subject);
  return private.rate_count(p_bucket, p_subject, p_window_s) <= p_max;
end $$;

create or replace function private.raise_alert(p_rule text, p_severity text, p_actor uuid, p_subject text, p_reason text)
returns void language plpgsql volatile set search_path = '' as $$
declare v_id bigint;
begin
  select a.id into v_id from private.security_alerts a
   where a.rule = p_rule and a.status = 'open'
     and a.actor_id is not distinct from p_actor
     and a.subject is not distinct from p_subject
     and a.last_seen_at > now() - interval '1 hour'
   order by a.id desc limit 1;
  if v_id is not null then
    update private.security_alerts set occurrences = occurrences + 1, last_seen_at = now(), reason = p_reason where id = v_id;
  else
    insert into private.security_alerts (rule, severity, actor_id, subject, reason)
    values (p_rule, p_severity, p_actor, p_subject, p_reason);
  end if;
end $$;

create or replace function private.evaluate_alerts(e private.audit_events) returns void
language plpgsql volatile set search_path = '' as $$
declare
  cfg private.settings;
  n int;
  who text := coalesce(e.actor_id::text, 'ip:' || coalesce(e.ip, 'unknown'));
begin
  select * into cfg from private.settings;

  if e.event_type = 'coord.export' and e.outcome = 'success' then
    select count(*) into n from private.audit_events a
     where a.actor_id = e.actor_id and a.event_type = 'coord.export' and a.outcome = 'success' and a.at > now() - interval '10 minutes';
    if n >= cfg.alert_exports_per_10min then
      perform private.raise_alert('repeated_exports', 'medium', e.actor_id, null,
        format('%s company exports within 10 minutes', n));
    end if;
  end if;

  if e.event_type in ('coord.applicants', 'coord.export') and e.outcome = 'success' then
    select count(distinct a.company_key) into n from private.audit_events a
     where a.actor_id = e.actor_id and a.event_type in ('coord.applicants', 'coord.export')
       and a.outcome = 'success' and a.at > now() - interval '1 hour';
    if n >= cfg.alert_companies_per_hour then
      perform private.raise_alert('many_companies', 'medium', e.actor_id, null,
        format('Applicant lists for %s different companies within 1 hour', n));
    end if;
    select count(*) into n from private.audit_events a
     where a.actor_id = e.actor_id and a.event_type = 'coord.applicants' and a.outcome = 'success'
       and a.at > now() - interval '10 minutes';
    if n >= cfg.alert_views_per_10min then
      perform private.raise_alert('rapid_list_access', 'low', e.actor_id, null,
        format('%s applicant-list views within 10 minutes', n));
    end if;
  end if;

  if e.outcome = 'denied' then
    select count(*) into n from private.audit_events a
     where a.outcome = 'denied' and a.at > now() - interval '10 minutes'
       and (case when e.actor_id is not null then a.actor_id = e.actor_id else a.actor_id is null and a.ip is not distinct from e.ip end);
    if n >= cfg.alert_denied_per_10min then
      perform private.raise_alert('repeated_denials', 'medium', e.actor_id, who,
        format('%s denied requests within 10 minutes', n));
    end if;
  end if;

  if e.event_type = 'auth.login' and e.outcome in ('failure', 'denied') then
    select count(*) into n from private.audit_events a
     where a.event_type = 'auth.login' and a.outcome in ('failure', 'denied') and a.at > now() - interval '15 minutes'
       and (case when e.actor_id is not null then a.actor_id = e.actor_id else a.actor_id is null and a.ip is not distinct from e.ip end);
    if n >= cfg.alert_login_fail_per_15min then
      perform private.raise_alert('login_failures', 'medium', e.actor_id, who,
        format('%s failed sign-ins within 15 minutes', n));
    end if;
  end if;

  if e.event_type = 'device.unrecognized' then
    perform private.raise_alert('unregistered_device', 'high', e.actor_id, null,
      'Sign-in from a browser that is not the registered device');
  end if;

  if e.event_type = 'device.enroll' and e.outcome = 'denied' then
    select count(*) into n from private.audit_events a
     where a.actor_id = e.actor_id and a.event_type = 'device.enroll' and a.outcome = 'denied' and a.at > now() - interval '1 hour';
    if n >= cfg.alert_enroll_denied_per_hour then
      perform private.raise_alert('enrollment_attempts', 'high', e.actor_id, null,
        format('%s refused device registrations within 1 hour', n));
    end if;
  end if;

  if e.event_type = 'device.enroll' and e.outcome = 'success' then
    select count(*) into n from private.audit_events a
     where a.actor_id = e.actor_id and a.event_type = 'device.enroll' and a.outcome = 'success' and a.at > now() - interval '7 days';
    if n >= cfg.alert_device_changes_per_week then
      perform private.raise_alert('frequent_device_changes', 'medium', e.actor_id, null,
        format('%s device registrations within 7 days', n));
    end if;
  end if;

  if e.event_type = 'session.concurrent' then
    perform private.raise_alert('concurrent_session', 'medium', e.actor_id, null,
      'Another recently active session for this account was signed out');
  end if;
end $$;

-- Writes one audit event and evaluates the alert rules. Never raises:
-- a logging problem must not change an access decision.
create or replace function private.audit(
  p_actor uuid, p_role text, p_type text, p_outcome text,
  p_company text default null, p_target uuid default null, p_device uuid default null,
  p_ip text default null, p_ua text default null, p_request text default null,
  p_detail jsonb default '{}'::jsonb)
returns void language plpgsql volatile set search_path = '' as $$
declare e private.audit_events;
begin
  insert into private.audit_events (actor_id, actor_role, event_type, outcome, company_key, target_id, device_id,
                                    ip, user_agent, request_id, detail)
  values (p_actor, coalesce(p_role, 'unknown'), left(p_type, 60), p_outcome, left(p_company, 120), p_target, p_device,
          left(p_ip, 100), left(p_ua, 300), left(p_request, 64), coalesce(p_detail, '{}'::jsonb))
  returning * into e;
  perform private.evaluate_alerts(e);
  if random() < 0.01 then
    perform set_config('cl25m.audit_retention', 'on', true);
    delete from private.audit_events
     where at < now() - make_interval(days => (select s.audit_retention_days from private.settings s));
    perform set_config('cl25m.audit_retention', 'off', true);
  end if;
exception when others then
  raise warning 'audit write failed: %', sqlerrm;
end $$;

create or replace function private.actor_role(p_uid uuid) returns text
language sql stable set search_path = '' as $$
  select case
    when p_uid is null then 'anonymous'
    when exists (select 1 from public.admins a where a.user_id = p_uid) then 'admin'
    when exists (select 1 from public.team_members t where t.user_id = p_uid) then 'coordinator'
    when exists (select 1 from public.students s where s.user_id = p_uid) then 'student'
    else 'none' end
$$;

-- ---------------------------------------------------------------------
-- 5. Coordinator authorization (single gate for every coordinator call)
-- ---------------------------------------------------------------------
-- ctx (built by the edge function from the VERIFIED token, never from the
-- request body): {"uid","sid","aal","device_id","ip","ua","req"}

create or replace function private.ctx_uuid(ctx jsonb, k text) returns uuid
language sql immutable set search_path = '' as $$
  select case when (ctx ->> k) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (ctx ->> k)::uuid end
$$;

-- Returns null when allowed, otherwise a reason code (and logs the denial).
create or replace function private.coord_gate(
  ctx jsonb, p_action text, p_company text default null,
  p_need_password boolean default true, p_need_device boolean default true)
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_sid uuid := private.ctx_uuid(ctx, 'sid');
  v_dev uuid := private.ctx_uuid(ctx, 'device_id');
  t public.team_members;
  cfg private.settings;
  v_reason text;
  v_bucket text;
  v_window int;
  v_max int;
begin
  select * into cfg from private.settings;
  select * into t from public.team_members m where m.user_id = v_uid;

  if v_uid is null or t.user_id is null or t.revoked_at is not null then
    v_reason := 'not_coordinator';
  elsif t.suspended_at is not null then
    v_reason := 'suspended';
  elsif not private.session_alive(v_uid, v_sid) then
    v_reason := 'session';
  elsif coalesce(ctx ->> 'aal', '') <> 'aal2' then
    v_reason := 'mfa';
  elsif p_need_password and t.must_change_password then
    v_reason := 'password';
  elsif p_need_device and (v_dev is null or not exists (
          select 1 from private.coordinator_devices d where d.id = v_dev and d.user_id = v_uid and d.status = 'active')) then
    v_reason := 'device';
  elsif p_company is not null and not private.company_assigned(v_uid, p_company) then
    v_reason := 'company';
  end if;

  if v_reason is null then
    v_bucket := 'coord.' || p_action;
    v_window := case p_action when 'export' then 3600 when 'enroll' then 3600 when 'password' then 3600 else 600 end;
    v_max := case p_action
               when 'applicants' then cfg.rate_view_per_10min
               when 'export' then cfg.rate_export_per_hour
               when 'enroll' then cfg.rate_enroll_per_hour
               when 'password' then cfg.rate_password_per_hour
               when 'outreach' then cfg.rate_outreach_per_10min
               else cfg.rate_dashboard_per_10min end;
    if not private.rate_hit(v_bucket, v_uid::text, v_window, v_max) then
      v_reason := 'rate';
    end if;
  end if;

  if v_reason is not null then
    perform private.audit(v_uid, private.actor_role(v_uid), 'coord.' || p_action, 'denied', p_company, null, v_dev,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', jsonb_build_object('reason', v_reason));
  elsif v_dev is not null and p_need_device then
    update private.coordinator_devices set last_used_at = now() where id = v_dev;
  end if;
  return v_reason;
end $$;

-- Group key of a company (typo-tolerant clusters), or the key itself.
create or replace function private.group_of(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select g.group_key from private.company_groups() g where g.company_key = p_key), p_key)
$$;

create or replace function private.company_assigned(p_uid uuid, p_company text) returns boolean
language sql stable security definer set search_path = '' as $$
  with req as (select private.group_of(public.company_key(p_company)) as g)
  select public.company_key(p_company) <> '' and exists (
    select 1 from private.coordinator_companies c, req
     where c.user_id = p_uid
       and (c.company_key = req.g or private.group_of(c.company_key) = req.g or public.same_company_key(c.company_key, req.g))
  )
$$;

-- ---------------------------------------------------------------------
-- 6. Server functions for the coordinator-api edge function (service_role)
-- ---------------------------------------------------------------------

-- Where the coordinator is in the access flow. Returns the active device's
-- PUBLIC key so the edge function can verify request signatures.
create or replace function public.svc_coordinator_status(ctx jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_sid uuid := private.ctx_uuid(ctx, 'sid');
  t public.team_members;
  d private.coordinator_devices;
  v_ever boolean;
  v_grant boolean;
  v_mfa boolean;
begin
  select * into t from public.team_members m where m.user_id = v_uid;
  if t.user_id is null or t.revoked_at is not null or t.suspended_at is not null
     or not private.session_alive(v_uid, v_sid) then
    return jsonb_build_object('state', 'unavailable');
  end if;
  v_mfa := exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified');
  if coalesce(ctx ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object('state', case when v_mfa then 'mfa_verify' else 'mfa_setup' end, 'email', t.email);
  end if;
  if t.must_change_password then
    return jsonb_build_object('state', 'password_change', 'email', t.email);
  end if;
  select * into d from private.coordinator_devices x where x.user_id = v_uid and x.status = 'active';
  v_ever := exists (select 1 from private.coordinator_devices x where x.user_id = v_uid);
  v_grant := exists (select 1 from private.device_replacement_grants g
                      where g.user_id = v_uid and g.used_at is null and g.expires_at > now());
  if d.id is null then
    return jsonb_build_object('state', case when not v_ever or v_grant then 'device_enroll' else 'device_approval_required' end,
                              'email', t.email);
  end if;
  return jsonb_build_object('state', 'device_check', 'email', t.email,
                            'device', jsonb_build_object('id', d.id, 'public_key', d.public_key, 'enrolled_at', d.enrolled_at));
end $$;

-- One-time nonce (replay protection for signed requests).
create or replace function public.svc_nonce_use(p_uid uuid, p_nonce text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  if p_uid is null or p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' then return false; end if;
  insert into private.device_nonces (user_id, nonce) values (p_uid, p_nonce) on conflict do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- Registers this browser's public key as the coordinator's device.
create or replace function public.svc_device_enroll(ctx jsonb, p_public_key jsonb, p_thumbprint text, p_label text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_reason text;
  v_ever boolean;
  v_grant private.device_replacement_grants;
  v_id uuid;
begin
  v_reason := private.coord_gate(ctx, 'enroll', null, true, false);
  if v_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  -- Serialize enrollments for this account.
  perform 1 from public.team_members where user_id = v_uid for update;

  if jsonb_typeof(p_public_key) <> 'object' or p_public_key ? 'd'
     or p_public_key ->> 'kty' <> 'EC' or p_public_key ->> 'crv' <> 'P-256'
     or coalesce(p_public_key ->> 'x', '') !~ '^[A-Za-z0-9_-]{43}$'
     or coalesce(p_public_key ->> 'y', '') !~ '^[A-Za-z0-9_-]{43}$'
     or coalesce(p_thumbprint, '') !~ '^[A-Za-z0-9_-]{43}$' then
    v_reason := 'bad_key';
  elsif exists (select 1 from private.coordinator_devices d where d.user_id = v_uid and d.status = 'active') then
    v_reason := 'already_registered';
  elsif exists (select 1 from private.coordinator_devices d where d.key_thumbprint = p_thumbprint) then
    v_reason := 'key_reused';
  else
    v_ever := exists (select 1 from private.coordinator_devices d where d.user_id = v_uid);
    select * into v_grant from private.device_replacement_grants g
     where g.user_id = v_uid and g.used_at is null and g.expires_at > now();
    if v_ever and v_grant.user_id is null then
      v_reason := 'approval_required';
    end if;
  end if;

  if v_reason is not null then
    perform private.audit(v_uid, 'coordinator', 'device.enroll', 'denied', null, null, null,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', jsonb_build_object('reason', v_reason));
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  insert into private.coordinator_devices (user_id, public_key, key_thumbprint, label, user_agent, ip)
  values (v_uid, jsonb_build_object('kty', 'EC', 'crv', 'P-256', 'x', p_public_key ->> 'x', 'y', p_public_key ->> 'y'),
          p_thumbprint, left(public.clean_text(p_label), 80), left(ctx ->> 'ua', 300), left(ctx ->> 'ip', 100))
  returning id into v_id;
  if v_grant.user_id is not null then
    update private.device_replacement_grants set used_at = now() where user_id = v_uid;
  end if;
  perform private.audit(v_uid, 'coordinator', 'device.enroll', 'success', null, null, v_id,
                        ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req',
                        jsonb_build_object('replacement', v_grant.user_id is not null));
  return jsonb_build_object('ok', true, 'device_id', v_id);
end $$;

-- Generic gate for steps finished by the edge function (password change).
create or replace function public.svc_coord_check(ctx jsonb, p_action text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text;
begin
  if p_action <> 'password' then
    return jsonb_build_object('ok', false, 'reason', 'bad_action');
  end if;
  v_reason := private.coord_gate(ctx, 'password', null, false, false);
  return jsonb_build_object('ok', v_reason is null, 'reason', v_reason);
end $$;

-- Called after the edge function has set the new password.
create or replace function public.svc_coord_password_changed(ctx jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_sid uuid := private.ctx_uuid(ctx, 'sid');
  n int;
begin
  update public.team_members set must_change_password = false, password_changed_at = now()
   where user_id = v_uid and revoked_at is null and suspended_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_coordinator'); end if;
  delete from auth.sessions where user_id = v_uid and id <> v_sid;
  get diagnostics n = row_count;
  perform private.audit(v_uid, 'coordinator', 'account.password_changed', 'success', null, null, null,
                        ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', jsonb_build_object('other_sessions_ended', n));
  return jsonb_build_object('ok', true);
end $$;

-- After device verification: keep only this session (single active session).
create or replace function public.svc_coord_session_begin(ctx jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_sid uuid := private.ctx_uuid(ctx, 'sid');
  v_reason text;
  v_recent int;
  n int;
begin
  v_reason := private.coord_gate(ctx, 'session', null);
  if v_reason is not null then return jsonb_build_object('ok', false, 'reason', v_reason); end if;
  select count(*) into v_recent from auth.sessions s
   where s.user_id = v_uid and s.id <> v_sid
     and coalesce(s.refreshed_at, s.updated_at, s.created_at) > now() - interval '30 minutes';
  delete from auth.sessions where user_id = v_uid and id <> v_sid;
  get diagnostics n = row_count;
  if v_recent > 0 then
    perform private.audit(v_uid, 'coordinator', 'session.concurrent', 'success', null, null,
                          private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req',
                          jsonb_build_object('recent_other_sessions', v_recent));
  end if;
  perform private.audit(v_uid, 'coordinator', 'session.begin', 'success', null, null,
                        private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req',
                        jsonb_build_object('other_sessions_ended', n));
  return jsonb_build_object('ok', true, 'other_sessions_ended', n);
end $$;

-- Aggregates + the coordinator's assigned companies. No identities.
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
begin
  v_reason := private.coord_gate(ctx, 'dashboard', null);
  if v_reason is not null then return jsonb_build_object('ok', false, 'reason', v_reason); end if;

  select count(*) into v_total from public.students;

  with g as (select * from private.company_groups()),
  rel as (select a.student_id, a.company_name, a.created_at, g.group_key
            from public.applications a join g on g.company_key = a.company_key),
  per as (select rel.group_key, count(distinct rel.student_id)::int as n from rel group by rel.group_key),
  spelling as (
    select distinct on (x.group_key) x.group_key, x.company_name
      from (select rel.group_key, rel.company_name, count(*) as uses, min(rel.created_at) as first_at
              from rel group by rel.group_key, rel.company_name) x
     order by x.group_key, x.uses desc, (x.company_name ~ '[A-Z]') desc, x.first_at asc)
  select coalesce(jsonb_agg(jsonb_build_object('company_key', per.group_key, 'company', sp.company_name, 'students', per.n)
                            order by per.n desc, sp.company_name), '[]'::jsonb)
    into v_stats
    from per join spelling sp using (group_key);

  select coalesce(jsonb_agg(jsonb_build_object('stage', x.application_stage, 'count', x.n) order by x.application_stage), '[]'::jsonb)
    into v_stages
    from (select a.application_stage, count(*)::int as n from public.applications a group by a.application_stage) x;

  -- Upcoming assessments: company, date and HOW MANY students. No identities.
  with g as (select * from private.company_groups())
  select coalesce(jsonb_agg(jsonb_build_object('company_key', x.group_key, 'date', x.test_date, 'students', x.n)
                            order by x.test_date, x.group_key), '[]'::jsonb)
    into v_upcoming
    from (select g.group_key, a.test_date, count(distinct a.student_id)::int as n
            from public.applications a join g on g.company_key = a.company_key
           where a.test_date between current_date and current_date + 45
           group by g.group_key, a.test_date) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'company_key', c.company_key,
           'company', c.display_name,
           'applicants', (select count(distinct a.student_id) from public.applications a
                           where private.group_of(a.company_key) = private.group_of(c.company_key)),
           'outreach', (select to_jsonb(o) - 'updated_by' from private.company_outreach o where o.company_key = c.company_key)
         ) order by c.display_name), '[]'::jsonb)
    into v_companies
    from private.coordinator_companies c where c.user_id = v_uid;

  perform private.audit(v_uid, 'coordinator', 'coord.dashboard', 'success', null, null,
                        private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req');
  return jsonb_build_object('ok', true, 'total_students', v_total, 'stats', v_stats, 'stages', v_stages,
                            'upcoming', v_upcoming, 'companies', v_companies, 'refreshed_at', now());
end $$;

-- Roll-number list for ONE assigned company (view or export).
create or replace function public.svc_coord_applicants(ctx jsonb, p_company text, p_purpose text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_action text := case when p_purpose = 'export' then 'export' else 'applicants' end;
  v_key text := public.company_key(left(coalesce(p_company, ''), 120));
  v_group text;
  v_reason text;
  v_rows jsonb;
  v_name text;
  n int;
begin
  if v_key = '' then
    perform private.audit(v_uid, private.actor_role(v_uid), 'coord.' || v_action, 'denied', null, null, null,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', jsonb_build_object('reason', 'bad_company'));
    return jsonb_build_object('ok', false, 'reason', 'company');
  end if;
  v_reason := private.coord_gate(ctx, v_action, v_key);
  if v_reason is not null then return jsonb_build_object('ok', false, 'reason', v_reason); end if;

  v_group := private.group_of(v_key);
  select coalesce(jsonb_agg(jsonb_build_object(
           'roll_number', s.roll_number,
           'stage', a.application_stage,
           'assessment_date', a.test_date,
           'applied_on', (a.created_at at time zone 'Asia/Kolkata')::date,
           'updated_at', a.updated_at) order by s.roll_number), '[]'::jsonb),
         count(*)
    into v_rows, n
    from public.applications a join public.students s on s.id = a.student_id
   where private.group_of(a.company_key) = v_group;

  select coalesce(
           (select c.display_name from private.coordinator_companies c
             where c.user_id = v_uid and (c.company_key = v_group or private.group_of(c.company_key) = v_group) limit 1),
           p_company)
    into v_name;

  perform private.audit(v_uid, 'coordinator', 'coord.' || v_action, 'success', v_group, null,
                        private.ctx_uuid(ctx, 'device_id'), ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req',
                        jsonb_build_object('rows', n));
  return jsonb_build_object('ok', true, 'company_key', v_group, 'company', v_name, 'rows', v_rows, 'generated_at', now());
end $$;

-- Outreach / coordination record for ONE assigned company.
create or replace function private.outreach_upsert(p_actor uuid, p_company text, p_display text, p_fields jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare
  v_key text := public.company_key(p_company);
  o private.company_outreach;
begin
  if v_key = '' or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'Invalid outreach update' using errcode = '22023';
  end if;
  -- Dates must be plain YYYY-MM-DD (no 'today', 'infinity' and similar);
  -- next_action is limited to 300 characters (longer is refused, not cut).
  if exists (select 1 from unnest(array['last_contact', 'next_action_date', 'assessment_date']) k
              where coalesce(p_fields ->> k, '') !~ '^(\d{4}-\d{2}-\d{2})?$')
     or char_length(coalesce(p_fields ->> 'next_action', '')) > 300 then
    raise exception 'Invalid outreach update' using errcode = '22023';
  end if;
  insert into private.company_outreach as c (company_key, display_name, outreach_status, recruitment_stage, last_contact,
                                             next_action, next_action_date, assessment_date, updated_by, updated_at)
  values (v_key, coalesce(public.clean_text(p_display), public.clean_text(p_company)),
          coalesce(p_fields ->> 'outreach_status', 'not_started'),
          coalesce(p_fields ->> 'recruitment_stage', 'not_open'),
          nullif(p_fields ->> 'last_contact', '')::date,
          public.clean_text(p_fields ->> 'next_action'),
          nullif(p_fields ->> 'next_action_date', '')::date,
          nullif(p_fields ->> 'assessment_date', '')::date,
          p_actor, now())
  on conflict (company_key) do update set
    outreach_status   = case when p_fields ? 'outreach_status'   then excluded.outreach_status   else c.outreach_status end,
    recruitment_stage = case when p_fields ? 'recruitment_stage' then excluded.recruitment_stage else c.recruitment_stage end,
    last_contact      = case when p_fields ? 'last_contact'      then excluded.last_contact      else c.last_contact end,
    next_action       = case when p_fields ? 'next_action'       then excluded.next_action       else c.next_action end,
    next_action_date  = case when p_fields ? 'next_action_date'  then excluded.next_action_date  else c.next_action_date end,
    assessment_date   = case when p_fields ? 'assessment_date'   then excluded.assessment_date   else c.assessment_date end,
    updated_by = p_actor, updated_at = now()
  returning * into o;
  return to_jsonb(o) - 'updated_by';
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
  -- Records are kept under the assignment's key so admin and coordinator share one row.
  select c.company_key, c.display_name into v_key, v_display from private.coordinator_companies c
   where c.user_id = v_uid and (c.company_key = v_key or private.group_of(c.company_key) = private.group_of(v_key))
   limit 1;
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

-- Generic event logging for the edge functions (login results, admin
-- exports, unrecognised devices, credential changes).
create or replace function public.svc_log_event(
  p_actor uuid, p_type text, p_outcome text, p_ip text, p_ua text, p_request text,
  p_detail jsonb default '{}'::jsonb, p_target uuid default null, p_company text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_type !~ '^[a-z_]+\.[a-z_]+$' then raise exception 'bad event type'; end if;
  perform private.audit(p_actor, private.actor_role(p_actor), p_type, p_outcome, p_company, p_target, null,
                        p_ip, p_ua, p_request, p_detail);
end $$;

-- Staff sign-in throttle (checked before the password is tried).
create or replace function public.svc_staff_login_gate(p_email text, p_ip text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  cfg private.settings;
  w int;
  n_email int;
  n_ip int;
begin
  select * into cfg from private.settings;
  w := cfg.staff_login_window_minutes * 60;
  n_email := private.rate_count('login_fail_email', lower(btrim(coalesce(p_email, ''))), w);
  n_ip := private.rate_count('login_fail_ip', coalesce(p_ip, 'unknown'), w);
  if n_email >= cfg.staff_login_fail_per_account or n_ip >= cfg.staff_login_fail_per_ip then
    perform private.rate_add('login_fail_ip', coalesce(p_ip, 'unknown'));
    return jsonb_build_object('allowed', false, 'retry_after', w);
  end if;
  return jsonb_build_object('allowed', true);
end $$;

-- Records the sign-in outcome and says which portal the account may use.
create or replace function public.svc_staff_login_result(
  p_email text, p_uid uuid, p_success boolean, p_ip text, p_ua text, p_request text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid uuid := coalesce(p_uid, (select u.id from auth.users u where lower(u.email) = v_email));
  t public.team_members;
  v_role text := 'none';
begin
  if not p_success then
    perform private.rate_add('login_fail_email', v_email);
    perform private.rate_add('login_fail_ip', coalesce(p_ip, 'unknown'));
    perform private.audit(v_uid, private.actor_role(v_uid), 'auth.login', 'failure', null, null, null, p_ip, p_ua, p_request,
                          case when v_uid is null then jsonb_build_object('unknown_account', true) else '{}'::jsonb end);
    return jsonb_build_object('role', 'none');
  end if;

  if exists (select 1 from public.admins a where a.user_id = v_uid) then
    v_role := 'admin';
  else
    select * into t from public.team_members m where m.user_id = v_uid;
    if t.user_id is not null and t.revoked_at is null and t.suspended_at is null then
      v_role := 'coordinator';
    end if;
  end if;
  perform private.audit(v_uid, private.actor_role(v_uid), 'auth.login',
                        case when v_role = 'none' then 'denied' else 'success' end,
                        null, null, null, p_ip, p_ua, p_request, '{}'::jsonb);
  return jsonb_build_object('role', v_role);
end $$;

-- Provisioning support for the admin-security edge function.
create or replace function public.svc_coordinator_provision(p_admin uuid, p_uid uuid, p_email text, p_ip text, p_ua text, p_request text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email));
begin
  if not exists (select 1 from public.admins a where a.user_id = p_admin) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.students s where s.user_id = p_uid) then
    return jsonb_build_object('ok', false, 'reason', 'student_account');
  end if;
  if exists (select 1 from public.admins a where a.user_id = p_uid) then
    return jsonb_build_object('ok', false, 'reason', 'admin_account');
  end if;
  insert into public.team_members (user_id, email, granted_by, must_change_password, credential_issued_at)
  values (p_uid, v_email, p_admin, true, now())
  on conflict (user_id) do update set revoked_at = null, suspended_at = null, suspended_reason = null,
    email = excluded.email, granted_by = p_admin, granted_at = now(),
    must_change_password = true, password_changed_at = null, credential_issued_at = now();
  delete from auth.sessions where user_id = p_uid;
  perform private.audit(p_admin, 'admin', 'admin.coordinator_provisioned', 'success', null, p_uid, null,
                        p_ip, p_ua, p_request, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- Marks a coordinator credential as freshly issued (after a reset).
create or replace function public.svc_coordinator_credential_reset(p_admin uuid, p_uid uuid, p_ip text, p_ua text, p_request text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.admins a where a.user_id = p_admin) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.team_members set must_change_password = true, password_changed_at = null, credential_issued_at = now()
   where user_id = p_uid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_coordinator'); end if;
  delete from auth.sessions where user_id = p_uid;
  perform private.audit(p_admin, 'admin', 'admin.coordinator_password_reset', 'success', null, p_uid, null,
                        p_ip, p_ua, p_request, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- Coordinator user id for an email (edge use only).
create or replace function public.svc_coordinator_by_id(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('user_id', t.user_id, 'email', t.email) from public.team_members t where t.user_id = p_uid), 'null'::jsonb)
$$;

-- ---------------------------------------------------------------------
-- 7. Administrator functions (browser, primary administrator only)
-- ---------------------------------------------------------------------
create or replace function private.require_admin() returns uuid
language plpgsql stable set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return auth.uid();
end $$;

create or replace function private.admin_audit(p_type text, p_target uuid, p_detail jsonb default '{}'::jsonb)
returns void language sql volatile set search_path = '' as $$
  select private.audit(auth.uid(), 'admin', p_type, 'success', null, p_target, null,
                       private.req_ip(), private.req_header('user-agent'), null, p_detail)
$$;

create or replace function public.admin_coordinators()
returns table (user_id uuid, email text, status text, must_change_password boolean, password_changed_at timestamptz,
               mfa_enrolled boolean, device_status text, device_enrolled_at timestamptz, device_last_used_at timestamptz,
               device_label text, replacement_pending boolean, active_sessions int, last_sign_in_at timestamptz,
               companies jsonb, granted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
  select t.user_id, t.email,
         case when t.revoked_at is not null then 'removed' when t.suspended_at is not null then 'suspended' else 'active' end,
         t.must_change_password, t.password_changed_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = t.user_id and f.status = 'verified'),
         case when d.id is not null then 'registered'
              when exists (select 1 from private.coordinator_devices x where x.user_id = t.user_id) then 'revoked'
              else 'none' end,
         d.enrolled_at, d.last_used_at, d.label,
         exists (select 1 from private.device_replacement_grants g where g.user_id = t.user_id and g.used_at is null and g.expires_at > now()),
         (select count(*)::int from auth.sessions s where s.user_id = t.user_id),
         u.last_sign_in_at,
         coalesce((select jsonb_agg(jsonb_build_object('company_key', c.company_key, 'company', c.display_name) order by c.display_name)
                     from private.coordinator_companies c where c.user_id = t.user_id), '[]'::jsonb),
         t.granted_at
    from public.team_members t
    left join auth.users u on u.id = t.user_id
    left join private.coordinator_devices d on d.user_id = t.user_id and d.status = 'active'
   order by t.granted_at;
end $$;

create or replace function public.admin_coordinator_set_suspended(p_user_id uuid, p_suspend boolean, p_reason text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.team_members
     set suspended_at = case when p_suspend then now() else null end,
         suspended_reason = case when p_suspend then left(public.clean_text(p_reason), 300) else null end
   where user_id = p_user_id;
  if not found then raise exception 'Unknown coordinator' using errcode = 'P0002'; end if;
  if p_suspend then delete from auth.sessions where user_id = p_user_id; end if;
  perform private.admin_audit(case when p_suspend then 'admin.coordinator_suspended' else 'admin.coordinator_reactivated' end,
                              p_user_id, jsonb_build_object('reason', left(public.clean_text(p_reason), 300)));
end $$;

create or replace function public.admin_coordinator_revoke_sessions(p_user_id uuid)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_admin();
  if not exists (select 1 from public.team_members t where t.user_id = p_user_id) then
    raise exception 'Unknown coordinator' using errcode = 'P0002';
  end if;
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics n = row_count;
  perform private.admin_audit('admin.sessions_revoked', p_user_id, jsonb_build_object('sessions', n));
  return n;
end $$;

-- Revokes the registered device; with p_allow_replacement the coordinator
-- may register ONE new device within the replacement window.
create or replace function public.admin_coordinator_device(p_user_id uuid, p_allow_replacement boolean, p_reason text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_old uuid; v_hours int;
begin
  perform private.require_admin();
  if not exists (select 1 from public.team_members t where t.user_id = p_user_id) then
    raise exception 'Unknown coordinator' using errcode = 'P0002';
  end if;
  update private.coordinator_devices
     set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = left(public.clean_text(p_reason), 300)
   where user_id = p_user_id and status = 'active'
  returning id into v_old;
  delete from auth.sessions where user_id = p_user_id;
  if p_allow_replacement then
    select s.replacement_window_hours into v_hours from private.settings s;
    insert into private.device_replacement_grants (user_id, granted_by, expires_at, reason)
    values (p_user_id, auth.uid(), now() + make_interval(hours => v_hours), left(public.clean_text(p_reason), 300))
    on conflict (user_id) do update set granted_by = excluded.granted_by, granted_at = now(),
      expires_at = excluded.expires_at, reason = excluded.reason, used_at = null;
  else
    delete from private.device_replacement_grants where user_id = p_user_id;
  end if;
  perform private.admin_audit(case when p_allow_replacement then 'admin.device_replacement_approved' else 'admin.device_revoked' end,
                              p_user_id, jsonb_build_object('previous_device', v_old, 'reason', left(public.clean_text(p_reason), 300)));
end $$;

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
    v_key := public.company_key(v_name);
    continue when v_key = '' or v_key = any (v_keys);
    v_keys := v_keys || v_key;
    insert into private.coordinator_companies (user_id, company_key, display_name, assigned_by)
    values (p_user_id, v_key, v_name, auth.uid())
    on conflict (user_id, company_key) do update set display_name = excluded.display_name;
  end loop;
  delete from private.coordinator_companies where user_id = p_user_id and company_key <> all (v_keys);
  perform private.admin_audit('admin.companies_assigned', p_user_id, jsonb_build_object('companies', to_jsonb(v_keys)));
end $$;

create or replace function public.admin_audit_events(p_limit int default 200, p_before bigint default null,
                                                     p_type text default null, p_actor uuid default null)
returns table (id bigint, at timestamptz, actor_id uuid, actor_email text, actor_role text, event_type text, outcome text,
               company_key text, target_id uuid, target_email text, device_id uuid, ip text, user_agent text, detail jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
  select e.id, e.at, e.actor_id, ua.email::text, e.actor_role, e.event_type, e.outcome, e.company_key, e.target_id,
         ut.email::text, e.device_id, e.ip, e.user_agent, e.detail
    from private.audit_events e
    left join auth.users ua on ua.id = e.actor_id and e.actor_role <> 'student'
    left join auth.users ut on ut.id = e.target_id
   where (p_before is null or e.id < p_before)
     and (p_type is null or e.event_type like p_type || '%')
     and (p_actor is null or e.actor_id = p_actor)
   order by e.id desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

create or replace function public.admin_security_alerts(p_status text default null)
returns table (id bigint, created_at timestamptz, last_seen_at timestamptz, rule text, severity text, actor_id uuid,
               actor_email text, subject text, reason text, occurrences int, status text, reviewed_at timestamptz, review_note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
  select a.id, a.created_at, a.last_seen_at, a.rule, a.severity, a.actor_id, u.email::text, a.subject, a.reason,
         a.occurrences, a.status, a.reviewed_at, a.review_note
    from private.security_alerts a left join auth.users u on u.id = a.actor_id
   where p_status is null or a.status = p_status
   order by (a.status = 'open') desc, a.last_seen_at desc
   limit 300;
end $$;

create or replace function public.admin_review_alert(p_id bigint, p_status text, p_note text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_status not in ('open', 'reviewed', 'dismissed') then raise exception 'Invalid status' using errcode = '22023'; end if;
  update private.security_alerts
     set status = p_status, reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(public.clean_text(p_note), 500)
   where id = p_id;
  if not found then raise exception 'Unknown alert' using errcode = 'P0002'; end if;
  perform private.admin_audit('admin.alert_reviewed', null, jsonb_build_object('alert', p_id, 'status', p_status));
end $$;

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
    select c.company_key, min(c.display_name) from private.coordinator_companies c group by c.company_key
  ), k as (select distinct on (keys.company_key) keys.company_key, keys.display_name from keys order by keys.company_key)
  select k.company_key, coalesce(o.display_name, k.display_name),
         coalesce(o.outreach_status, 'not_started'), coalesce(o.recruitment_stage, 'not_open'),
         o.last_contact, o.next_action, o.next_action_date, o.assessment_date, o.updated_at, u.email::text,
         coalesce((select jsonb_agg(t.email order by t.email) from private.coordinator_companies c
                    join public.team_members t on t.user_id = c.user_id where c.company_key = k.company_key), '[]'::jsonb)
    from k left join private.company_outreach o on o.company_key = k.company_key
    left join auth.users u on u.id = o.updated_by
   order by 2;
end $$;

create or replace function public.admin_outreach_update(p_company text, p_fields jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_admin();
  v := private.outreach_upsert(auth.uid(), p_company, p_company, p_fields);
  perform private.admin_audit('admin.outreach_updated', null, jsonb_build_object('company', public.company_key(p_company)));
  return v;
end $$;

-- Removing a coordinator (existing function) now also clears their device,
-- assignments-in-effect stay for the record, and the change is audited.
create or replace function public.admin_revoke_team(p_user_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.team_members set revoked_at = now() where user_id = p_user_id and revoked_at is null;
  update private.coordinator_devices set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'access removed'
   where user_id = p_user_id and status = 'active';
  delete from private.device_replacement_grants where user_id = p_user_id;
  delete from auth.sessions where user_id = p_user_id;
  perform private.admin_audit('admin.coordinator_removed', p_user_id);
end $$;

-- Re-approval goes through admin-security (fresh credential + MFA + device).
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.admin_grant_team(text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_grant_team(text) from anon';
  end if;
end $$;

-- Staff stats: administrator or a student who has submitted (coordinators
-- get aggregates only through the device-verified API).
create or replace function public.company_application_stats()
returns table (company text, students int, percent numeric, total_relationships int, refreshed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (
    public.is_admin()
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
-- 8. Function privileges
--    Supabase grants EXECUTE on new public functions to anon and
--    authenticated by default, so every grant is set explicitly here.
-- ---------------------------------------------------------------------
do $$
declare
  f text;
  svc text[] := array[
    'public.svc_coordinator_status(jsonb)', 'public.svc_nonce_use(uuid, text)',
    'public.svc_device_enroll(jsonb, jsonb, text, text)', 'public.svc_coord_check(jsonb, text)',
    'public.svc_coord_password_changed(jsonb)', 'public.svc_coord_session_begin(jsonb)',
    'public.svc_coord_dashboard(jsonb)', 'public.svc_coord_applicants(jsonb, text, text)',
    'public.svc_coord_outreach_update(jsonb, text, jsonb)',
    'public.svc_log_event(uuid, text, text, text, text, text, jsonb, uuid, text)',
    'public.svc_staff_login_gate(text, text)', 'public.svc_staff_login_result(text, uuid, boolean, text, text, text)',
    'public.svc_coordinator_provision(uuid, uuid, text, text, text, text)',
    'public.svc_coordinator_credential_reset(uuid, uuid, text, text, text)',
    'public.svc_coordinator_by_id(uuid)'];
  adm text[] := array[
    'public.admin_coordinators()', 'public.admin_coordinator_set_suspended(uuid, boolean, text)',
    'public.admin_coordinator_revoke_sessions(uuid)', 'public.admin_coordinator_device(uuid, boolean, text)',
    'public.admin_coordinator_assign(uuid, text[])', 'public.admin_audit_events(int, bigint, text, uuid)',
    'public.admin_security_alerts(text)', 'public.admin_review_alert(bigint, text, text)',
    'public.admin_outreach()', 'public.admin_outreach_update(text, jsonb)', 'public.admin_revoke_team(uuid)',
    'public.company_application_stats()', 'public.is_admin()', 'public.is_staff()'];
begin
  foreach f in array svc || adm loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array svc loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach f in array adm loop
      execute format('grant execute on function %s to authenticated', f);
    end loop;
  end if;
end $$;

-- Earlier functions that only ever refuse anonymous callers: close them to anon too.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_list_team(), public.submit_applications(jsonb) from anon';
  end if;
end $$;

-- private.* helpers: owner only.
revoke all on all functions in schema private from public;

-- ---------------------------------------------------------------------
-- 9. Check: every public function the browser roles may call
-- ---------------------------------------------------------------------
select p.oid::regprocedure::text as function_name,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
 order by 1;
