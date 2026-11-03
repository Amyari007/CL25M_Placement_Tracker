-- =====================================================================
-- Coordinators: a 6-digit PIN replaces the authenticator app as the
-- second sign-in step. Everything else (own password, registered
-- computer, company limits, audit) is unchanged.
--
-- * First sign-in: the coordinator chooses a 6-digit PIN.
-- * Every later sign-in: password, then the PIN, then the registered
--   computer's signature. The PIN is checked on the server and bound to
--   that one sign-in session.
-- * 5 wrong PINs in 15 minutes: further tries refused for the rest of the
--   window, and a high alert for the administrator.
-- * The administrator's "Reset password" also clears the PIN.
-- Safe to run more than once. Deletes no data.
-- =====================================================================

alter table public.team_members add column if not exists pin_hash text;
alter table public.team_members add column if not exists pin_set_at timestamptz;
-- (The browser's column grants on team_members do not include these.)

alter table private.settings add column if not exists rate_pin_per_15min int not null default 5;

create table if not exists private.coordinator_pin_sessions (
  session_id  uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  verified_at timestamptz not null default now()
);
alter table private.coordinator_pin_sessions enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on private.coordinator_pin_sessions from %I', r);
    end if;
  end loop;
end $$;

-- Second step passed for THIS sign-in session: authenticator (AAL2) or PIN.
create or replace function private.second_factor_ok(p_uid uuid, p_sid uuid, p_aal text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_aal, '') = 'aal2'
      or exists (select 1 from private.coordinator_pin_sessions s
                  where s.session_id = p_sid and s.user_id = p_uid
                    and s.verified_at > now() - interval '24 hours')
$$;

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
  elsif not private.second_factor_ok(v_uid, v_sid, ctx ->> 'aal') then
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
    v_window := case p_action when 'export' then 3600 when 'enroll' then 3600 when 'password' then 3600 when 'pin' then 900 else 600 end;
    v_max := case p_action
               when 'applicants' then cfg.rate_view_per_10min
               when 'export' then cfg.rate_export_per_hour
               when 'enroll' then cfg.rate_enroll_per_hour
               when 'password' then cfg.rate_password_per_hour
               when 'pin' then cfg.rate_pin_per_15min
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
  -- Second step: the coordinator's own 6-digit PIN (or an authenticator, if one is set up).
  v_mfa := exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified');
  if not private.second_factor_ok(v_uid, v_sid, ctx ->> 'aal') then
    return jsonb_build_object('state', case when v_mfa then 'mfa_verify' when t.pin_hash is not null then 'pin_verify' else 'pin_setup' end,
                              'email', t.email);
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

-- Sets (first time) or checks the coordinator's 6-digit PIN for this session.
create or replace function public.svc_coord_pin(ctx jsonb, p_action text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := private.ctx_uuid(ctx, 'uid');
  v_sid uuid := private.ctx_uuid(ctx, 'sid');
  t public.team_members;
  cfg private.settings;
  n int;
begin
  select * into cfg from private.settings;
  select * into t from public.team_members m where m.user_id = v_uid for update;
  if t.user_id is null or t.revoked_at is not null or t.suspended_at is not null
     or not private.session_alive(v_uid, v_sid) or p_action not in ('set', 'verify') then
    perform private.audit(v_uid, private.actor_role(v_uid), 'coord.pin', 'denied', null, null, null,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', jsonb_build_object('reason', 'unavailable'));
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;

  if p_action = 'set' then
    if t.pin_hash is not null then
      return jsonb_build_object('ok', false, 'reason', 'pin_exists');
    end if;
    if coalesce(p_pin, '') !~ '^[0-9]{6}$' or p_pin ~ '^(.)\1{5}$'
       or p_pin in ('123456', '654321', '012345', '543210', '123123', '121212', '112233') then
      return jsonb_build_object('ok', false, 'reason', 'weak_pin');
    end if;
    update public.team_members set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), pin_set_at = now()
     where user_id = v_uid;
    insert into private.coordinator_pin_sessions (session_id, user_id) values (v_sid, v_uid)
      on conflict (session_id) do update set verified_at = now();
    perform private.audit(v_uid, 'coordinator', 'account.pin_set', 'success', null, null, null,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', '{}'::jsonb);
    return jsonb_build_object('ok', true);
  end if;

  -- verify
  if t.pin_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'no_pin');
  end if;
  if private.rate_count('coord.pin_fail', v_uid::text, 900) >= cfg.rate_pin_per_15min then
    perform private.audit(v_uid, 'coordinator', 'coord.pin', 'denied', null, null, null,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', jsonb_build_object('reason', 'rate'));
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{6}$' or t.pin_hash <> extensions.crypt(p_pin, t.pin_hash) then
    perform private.rate_add('coord.pin_fail', v_uid::text);
    perform private.audit(v_uid, 'coordinator', 'coord.pin', 'failure', null, null, null,
                          ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', '{}'::jsonb);
    n := private.rate_count('coord.pin_fail', v_uid::text, 900);
    if n >= cfg.rate_pin_per_15min then
      perform private.raise_alert('pin_failures', 'high', v_uid, null, format('%s wrong PINs within 15 minutes', n));
    end if;
    return jsonb_build_object('ok', false, 'reason', 'wrong_pin');
  end if;
  insert into private.coordinator_pin_sessions (session_id, user_id) values (v_sid, v_uid)
    on conflict (session_id) do update set verified_at = now();
  perform private.audit(v_uid, 'coordinator', 'coord.pin', 'success', null, null, null,
                        ctx ->> 'ip', ctx ->> 'ua', ctx ->> 'req', '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

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
    must_change_password = true, password_changed_at = null, credential_issued_at = now(),
    pin_hash = null, pin_set_at = null;
  delete from auth.sessions where user_id = p_uid;
  delete from private.coordinator_pin_sessions where user_id = p_uid;
  perform private.audit(p_admin, 'admin', 'admin.coordinator_provisioned', 'success', null, p_uid, null,
                        p_ip, p_ua, p_request, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.svc_coordinator_credential_reset(p_admin uuid, p_uid uuid, p_ip text, p_ua text, p_request text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.admins a where a.user_id = p_admin) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.team_members set must_change_password = true, password_changed_at = null, credential_issued_at = now(),
         pin_hash = null, pin_set_at = null
   where user_id = p_uid;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_coordinator'); end if;
  delete from auth.sessions where user_id = p_uid;
  delete from private.coordinator_pin_sessions where user_id = p_uid;
  perform private.audit(p_admin, 'admin', 'admin.coordinator_password_reset', 'success', null, p_uid, null,
                        p_ip, p_ua, p_request, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

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
         (t.pin_hash is not null or exists (select 1 from auth.mfa_factors f where f.user_id = t.user_id and f.status = 'verified')),
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

do $$ begin
  execute 'revoke all on function public.svc_coord_pin(jsonb, text, text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.svc_coord_pin(jsonb, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.svc_coord_pin(jsonb, text, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.svc_coord_pin(jsonb, text, text) to service_role';
  end if;
end $$;
revoke all on all functions in schema private from public;

-- Check: coordinators and whether each has chosen a PIN yet
select email, pin_hash is not null as pin_chosen, must_change_password as still_on_temporary_password
  from public.team_members order by email;
