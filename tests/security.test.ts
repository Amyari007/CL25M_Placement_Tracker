/**
 * Restricted placement coordinators: database-level enforcement.
 * Every svc_* function is what the coordinator-api edge function calls;
 * here they are called directly (as service_role) to prove the database
 * itself refuses anything the gate does not allow.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';

let db: PGlite;
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = id(900);
const C1 = id(901);
const C2 = id(902);
const C3 = id(903);
const OUT = id(904);
const SA = id(1);
const SB = id(2);
const SC = id(3);

type Who = { role: 'anon' | 'authenticated'; uid?: string; aal?: string; sid?: string };
async function as<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.uid ?? '']);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(who.uid ? { sub: who.uid, session_id: who.sid ?? who.uid, aal: who.aal ?? 'aal1', role: who.role } : { role: who.role }),
    ]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<T>(sql, params);
    await db.exec('commit');
    return r.rows;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  await db.exec('begin');
  try {
    await db.exec('set local role service_role');
    const r = await db.query<T>(sql, params);
    await db.exec('commit');
    return r.rows;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
const admin: Who = { role: 'authenticated', uid: ADMIN };
type Ctx = { uid: string; sid?: string; aal?: string; device_id?: string | null; ip?: string; ua?: string; req?: string };
const ctx = (c: Ctx) => JSON.stringify({ sid: c.uid, aal: 'aal2', ip: '203.0.113.7', ua: 'vitest', req: 'req-1', ...c });
async function call(fn: string, c: Ctx, ...args: unknown[]) {
  const ph = args.map((_, i) => `$${i + 2}`).join(', ');
  const r = await svc<{ r: Record<string, any> }>(`select public.${fn}($1::jsonb${ph ? ', ' + ph : ''}) as r`, [ctx(c), ...args]);
  return r[0].r;
}
const KEY = (n: number) => ({ kty: 'EC', crv: 'P-256', x: ('x' + String(n)).padEnd(43, 'A'), y: ('y' + String(n)).padEnd(43, 'B') });
const THUMB = (n: number) => ('t' + String(n)).padEnd(43, 'C');
const devices: Record<string, string> = {};

async function provision(uid: string, email: string) {
  await svc(`select public.svc_coordinator_provision($1, $2, $3, null, null, null)`, [ADMIN, uid, email]);
  await db.exec(`insert into auth.sessions (id, user_id) values ('${uid}', '${uid}') on conflict do nothing`);
}
async function makeReady(uid: string, n: number) {
  await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${uid}', 'verified')`);
  expect((await call('svc_coord_check', { uid }, 'password')).ok).toBe(true);
  expect((await call('svc_coord_password_changed', { uid })).ok).toBe(true);
  const r = await call('svc_device_enroll', { uid }, JSON.stringify(KEY(n)), THUMB(n), 'Home laptop');
  expect(r).toMatchObject({ ok: true });
  devices[uid] = r.device_id;
}
const audit = async (where = 'true') =>
  (await db.query<Record<string, any>>(`select * from private.audit_events where ${where} order by id`)).rows;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync('tests/sql/supabase-stubs.sql', 'utf8'));
  await db.exec(`create publication supabase_realtime`);
  for (const f of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  await db.exec(`insert into auth.users (id, email) values
    ('${ADMIN}','admin@x.org'),('${C1}','coord.one@example.org'),('${C2}','coord.two@example.org'),
    ('${C3}','coord.three@example.org'),('${OUT}','outsider@x.org'),
    ('${SA}','cl25m001@students.invalid'),('${SB}','cl25m002@students.invalid'),('${SC}','cl25m003@students.invalid')`);
  await db.exec(`insert into public.admins (user_id) values ('${ADMIN}')`);
  await db.exec(`update public.students set user_id='${SA}', name='Alpha Student' where roll_number='CL25M001'`);
  await db.exec(`update public.students set user_id='${SB}', name='Beta Student' where roll_number='CL25M002'`);
  await db.exec(`update public.students set user_id='${SC}', name='Gamma Student' where roll_number='CL25M003'`);
  const sub = (uid: string, items: unknown[]) =>
    as({ role: 'authenticated', uid }, 'select * from public.submit_applications($1::jsonb)', [JSON.stringify(items)]);
  await sub(SA, [{ company_name: 'Commotion', test_date: '2035-12-01', notes: 'private note A' }, { company_name: 'Philips' }]);
  await sub(SB, [{ company_name: 'COMMOTION Pvt. Ltd.' }, { company_name: 'Siemens Healthineers' }]);
  await sub(SC, [{ company_name: 'Comotion' }, { company_name: 'GE Healthcare' }]);
  for (const [uid, email] of [[C1, 'coord.one@example.org'], [C2, 'coord.two@example.org'], [C3, 'coord.three@example.org']]) {
    await provision(uid, email);
  }
  await as({ ...admin }, `select public.admin_coordinator_assign($1, $2)`, [C1, ['Commotion', 'Philips']]);
  await as({ ...admin }, `select public.admin_coordinator_assign($1, $2)`, [C2, ['Siemens Healthineers']]);
});

// Each test starts with fresh rate-limit counters (rate limits are tested on their own).
beforeEach(async () => {
  await db.exec(`delete from private.rate_events`);
});

describe('coordinator onboarding gate (MFA → password rotation → device)', () => {
  it('walks the required states in order and never returns data before the end', async () => {
    expect(await call('svc_coordinator_status', { uid: C1, aal: 'aal1' })).toMatchObject({ state: 'pin_setup' });
    await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${C1}', 'verified')`);
    expect(await call('svc_coordinator_status', { uid: C1, aal: 'aal1' })).toMatchObject({ state: 'mfa_verify' });
    expect(await call('svc_coordinator_status', { uid: C1 })).toMatchObject({ state: 'password_change' });
    // device enrollment before password rotation is refused
    expect(await call('svc_device_enroll', { uid: C1 }, JSON.stringify(KEY(1)), THUMB(1), 'x')).toMatchObject({ ok: false, reason: 'password' });
    // password step itself needs MFA
    expect(await call('svc_coord_check', { uid: C1, aal: 'aal1' }, 'password')).toMatchObject({ ok: false, reason: 'mfa' });
    expect((await call('svc_coord_check', { uid: C1 }, 'password')).ok).toBe(true);
    expect((await call('svc_coord_password_changed', { uid: C1 })).ok).toBe(true);
    expect(await call('svc_coordinator_status', { uid: C1 })).toMatchObject({ state: 'device_enroll' });
    expect(await call('svc_coord_dashboard', { uid: C1 })).toEqual({ ok: false, reason: 'device' });
    const r = await call('svc_device_enroll', { uid: C1 }, JSON.stringify(KEY(1)), THUMB(1), 'Home laptop');
    expect(r.ok).toBe(true);
    devices[C1] = r.device_id;
    const st = await call('svc_coordinator_status', { uid: C1 });
    expect(st.state).toBe('device_check');
    expect(st.device.public_key).toEqual({ kty: 'EC', crv: 'P-256', x: KEY(1).x, y: KEY(1).y });
    expect(JSON.stringify(st)).not.toMatch(/"d"/);
  });
  it('rejects private keys and malformed keys at enrollment', async () => {
    await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${C3}', 'verified')`);
    await call('svc_coord_check', { uid: C3 }, 'password');
    await call('svc_coord_password_changed', { uid: C3 });
    expect(await call('svc_device_enroll', { uid: C3 }, JSON.stringify({ ...KEY(3), d: 'secret' }), THUMB(3), 'x')).toMatchObject({ reason: 'bad_key' });
    expect(await call('svc_device_enroll', { uid: C3 }, JSON.stringify({ kty: 'RSA' }), THUMB(3), 'x')).toMatchObject({ reason: 'bad_key' });
  });
  it('the same public key cannot be registered to two accounts', async () => {
    expect(await call('svc_device_enroll', { uid: C3 }, JSON.stringify(KEY(1)), THUMB(1), 'copy')).toMatchObject({ ok: false, reason: 'key_reused' });
    const r = await call('svc_device_enroll', { uid: C3 }, JSON.stringify(KEY(3)), THUMB(3), 'C3 home');
    expect(r.ok).toBe(true);
    devices[C3] = r.device_id;
  });
  it('a second browser cannot self-enroll once a device exists', async () => {
    expect(await call('svc_device_enroll', { uid: C1 }, JSON.stringify(KEY(11)), THUMB(11), 'other')).toMatchObject({ ok: false, reason: 'already_registered' });
  });
});

describe('6-digit PIN as the second sign-in step', () => {
  const P = id(905);
  const pin = (c: Ctx, action: string, value: string) => call('svc_coord_pin', c, action, value);
  beforeAll(async () => {
    await db.exec(`insert into auth.users (id, email) values ('${P}', 'pin.coord@x.org')`);
    await provision(P, 'pin.coord@x.org');
  });
  it('first sign-in: choose a PIN (weak ones refused); it counts for this session only', async () => {
    const s1 = { uid: P, aal: 'aal1' };
    expect(await call('svc_coordinator_status', s1)).toMatchObject({ state: 'pin_setup' });
    expect(await call('svc_coord_check', s1, 'password')).toMatchObject({ ok: false, reason: 'mfa' });
    for (const weak of ['123456', '111111', '12345', 'abcdef', '1234567']) expect(await pin(s1, 'set', weak)).toMatchObject({ ok: false, reason: 'weak_pin' });
    expect(await pin(s1, 'set', '480913')).toEqual({ ok: true });
    expect(await pin(s1, 'set', '777000')).toMatchObject({ ok: false, reason: 'pin_exists' });
    expect(await call('svc_coordinator_status', s1)).toMatchObject({ state: 'password_change' });
    expect((await call('svc_coord_check', s1, 'password')).ok).toBe(true);
    const stored = (await db.query<{ pin_hash: string }>(`select pin_hash from public.team_members where user_id = '${P}'`)).rows[0].pin_hash;
    expect(stored).toMatch(/^\$2[aby]\$/);
    expect(stored).not.toContain('480913');
  });
  it('a new sign-in session must enter the PIN again', async () => {
    const other = id(9051);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${other}', '${P}')`);
    const s2 = { uid: P, sid: other, aal: 'aal1' };
    expect(await call('svc_coordinator_status', s2)).toMatchObject({ state: 'pin_verify' });
    expect(await pin(s2, 'verify', '000000')).toMatchObject({ ok: false, reason: 'wrong_pin' });
    expect(await pin(s2, 'verify', '480913')).toEqual({ ok: true });
    expect(await call('svc_coordinator_status', s2)).toMatchObject({ state: 'password_change' });
  });
  it('5 wrong PINs lock PIN entry for 15 minutes and raise a high alert', async () => {
    const third = id(9052);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${third}', '${P}')`);
    const s3 = { uid: P, sid: third, aal: 'aal1' };
    for (let i = 0; i < 5; i++) expect(await pin(s3, 'verify', '000001')).toMatchObject({ reason: 'wrong_pin' });
    expect(await pin(s3, 'verify', '480913')).toMatchObject({ ok: false, reason: 'rate' });
    const a = (await db.query(`select severity from private.security_alerts where actor_id = '${P}' and rule = 'pin_failures'`)).rows;
    expect(a).toEqual([{ severity: 'high' }]);
  });
  it('a password reset by the administrator also clears the PIN', async () => {
    await svc(`select public.svc_coordinator_credential_reset($1, $2, null, null, null)`, [ADMIN, P]);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${P}', '${P}') on conflict do nothing`);
    expect(await call('svc_coordinator_status', { uid: P, aal: 'aal1' })).toMatchObject({ state: 'pin_setup' });
  });
  it('PIN data is not readable from the browser', async () => {
    await expect(as({ role: 'authenticated', uid: P }, 'select pin_hash from public.team_members')).rejects.toThrow(/permission denied/);
    await expect(as({ role: 'authenticated', uid: P }, `select public.svc_coord_pin('{}'::jsonb, 'verify', '000000')`)).rejects.toThrow(/permission denied/);
  });
});

describe('registered-device enforcement', () => {
  it('requires the caller’s own active device on every data call', async () => {
    expect(await call('svc_coord_dashboard', { uid: C1, device_id: null })).toEqual({ ok: false, reason: 'device' });
    expect(await call('svc_coord_dashboard', { uid: C1, device_id: devices[C3] })).toEqual({ ok: false, reason: 'device' });
    expect(await call('svc_coord_dashboard', { uid: C1, device_id: 'not-a-uuid' })).toEqual({ ok: false, reason: 'device' });
    expect((await call('svc_coord_dashboard', { uid: C1, device_id: devices[C1] })).ok).toBe(true);
  });
  it('after an admin revokes the device, the coordinator cannot re-enroll alone', async () => {
    await as(admin, `select public.admin_coordinator_device($1, false, 'lost laptop')`, [C3]);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C3}', '${C3}') on conflict do nothing`);
    expect(await call('svc_coord_dashboard', { uid: C3, device_id: devices[C3] })).toEqual({ ok: false, reason: 'device' });
    expect(await call('svc_coordinator_status', { uid: C3 })).toMatchObject({ state: 'device_approval_required' });
    expect(await call('svc_device_enroll', { uid: C3 }, JSON.stringify(KEY(31)), THUMB(31), 'new')).toMatchObject({ ok: false, reason: 'approval_required' });
  });
  it('an admin-approved replacement allows exactly one new device', async () => {
    await as(admin, `select public.admin_coordinator_device($1, true, 'new laptop')`, [C3]);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C3}', '${C3}') on conflict do nothing`);
    expect(await call('svc_coordinator_status', { uid: C3 })).toMatchObject({ state: 'device_enroll' });
    const r = await call('svc_device_enroll', { uid: C3 }, JSON.stringify(KEY(32)), THUMB(32), 'New laptop');
    expect(r.ok).toBe(true);
    devices[C3] = r.device_id;
    expect(await call('svc_device_enroll', { uid: C3 }, JSON.stringify(KEY(33)), THUMB(33), 'third')).toMatchObject({ reason: 'already_registered' });
    const ev = await audit(`event_type = 'admin.device_replacement_approved'`);
    expect(ev[0]).toMatchObject({ actor_id: ADMIN, target_id: C3, outcome: 'success' });
  });
  it('device changes on one account leave the other accounts untouched', async () => {
    const d = (await db.query<{ user_id: string; status: string }>(`select user_id, status from private.coordinator_devices where status = 'active' order by user_id`)).rows;
    expect(d.map((x) => x.user_id)).toEqual([C1, C3]);
    expect((await call('svc_coord_dashboard', { uid: C1, device_id: devices[C1] })).ok).toBe(true);
  });
  it('one-time nonces: replay and malformed nonces are refused', async () => {
    const n = 'nonce_ABCDEFGHIJKLMNOP';
    expect((await svc<{ ok: boolean }>(`select public.svc_nonce_use($1, $2) as ok`, [C1, n]))[0].ok).toBe(true);
    expect((await svc<{ ok: boolean }>(`select public.svc_nonce_use($1, $2) as ok`, [C1, n]))[0].ok).toBe(false);
    expect((await svc<{ ok: boolean }>(`select public.svc_nonce_use($1, $2) as ok`, [C1, 'short']))[0].ok).toBe(false);
  });
});

describe('sessions, suspension and MFA level', () => {
  it('a deleted session (signed out / revoked) is refused immediately', async () => {
    expect(await call('svc_coord_dashboard', { uid: C1, device_id: devices[C1], sid: id(5555) })).toEqual({ ok: false, reason: 'session' });
  });
  it('AAL1 tokens are refused even with a valid device', async () => {
    expect(await call('svc_coord_dashboard', { uid: C1, device_id: devices[C1], aal: 'aal1' })).toEqual({ ok: false, reason: 'mfa' });
  });
  it('session begin keeps only the current session and flags recent concurrent use', async () => {
    await db.exec(`insert into auth.sessions (user_id, refreshed_at) values ('${C1}', now()::timestamp)`);
    const ok = await call('svc_coord_session_begin', { uid: C1, device_id: devices[C1] });
    expect(ok).toMatchObject({ ok: true, other_sessions_ended: 1 });
    const left = (await db.query<{ n: number }>(`select count(*)::int n from auth.sessions where user_id = '${C1}'`)).rows[0].n;
    expect(left).toBe(1);
    const alerts = (await db.query(`select rule from private.security_alerts where actor_id = '${C1}' and rule = 'concurrent_session'`)).rows;
    expect(alerts).toHaveLength(1);
  });
  it('suspending one coordinator cuts them off and leaves the others working', async () => {
    await as(admin, `select public.admin_coordinator_set_suspended($1, true, 'investigation')`, [C3]);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C3}', '${C3}') on conflict do nothing`);
    expect(await call('svc_coord_dashboard', { uid: C3, device_id: devices[C3] })).toEqual({ ok: false, reason: 'suspended' });
    expect(await call('svc_coordinator_status', { uid: C3 })).toEqual({ state: 'unavailable' });
    expect((await call('svc_coord_dashboard', { uid: C1, device_id: devices[C1] })).ok).toBe(true);
    const list = await as<{ email: string; status: string; device_status: string }>(admin, 'select * from public.admin_coordinators()');
    expect(Object.fromEntries(list.filter((x) => x.email.startsWith('coord.')).map((x) => [x.email, x.status]))).toEqual({
      'coord.one@example.org': 'active', 'coord.two@example.org': 'active', 'coord.three@example.org': 'suspended',
    });
    await as(admin, `select public.admin_coordinator_set_suspended($1, false)`, [C3]);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C3}', '${C3}') on conflict do nothing`);
    expect((await call('svc_coord_dashboard', { uid: C3, device_id: devices[C3] })).ok).toBe(true);
  });
  it('a credential reset forces a new password before any data is returned', async () => {
    await svc(`select public.svc_coordinator_credential_reset($1, $2, null, null, null)`, [ADMIN, C3]);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C3}', '${C3}') on conflict do nothing`);
    expect(await call('svc_coord_dashboard', { uid: C3, device_id: devices[C3] })).toEqual({ ok: false, reason: 'password' });
    await call('svc_coord_password_changed', { uid: C3 });
    expect((await call('svc_coord_dashboard', { uid: C3, device_id: devices[C3] })).ok).toBe(true);
  });
  it('the administrator loses database access as soon as their session is deleted', async () => {
    expect((await as(admin, 'select public.is_admin() as a'))[0]).toEqual({ a: true });
    await db.exec(`delete from auth.sessions where id = '${ADMIN}'`);
    expect((await as(admin, 'select public.is_admin() as a'))[0]).toEqual({ a: false });
    expect(await as(admin, 'select id from public.applications')).toHaveLength(0);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${ADMIN}', '${ADMIN}')`);
  });
});

describe('company scoping and data minimisation', () => {
  it('returns roll numbers for an assigned company (any spelling) and nothing else', async () => {
    const r = await call('svc_coord_applicants', { uid: C1, device_id: devices[C1] }, 'COMMOTION pvt ltd', 'view');
    expect(r.ok).toBe(true);
    expect(r.rows.map((x: any) => x.roll_number)).toEqual(['CL25M001', 'CL25M002', 'CL25M003']);
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual(['applied_on', 'assessment_date', 'roll_number', 'stage', 'updated_at']);
    expect(JSON.stringify(r)).not.toMatch(/Alpha|Beta|Gamma|private note|students\.invalid/);
  });
  it('refuses companies that are not assigned, and altered identifiers', async () => {
    for (const company of ['Siemens Healthineers', 'GE Healthcare', 'Nonexistent Co', '', '%', "Commotion' or '1'='1"]) {
      const r = await call('svc_coord_applicants', { uid: C1, device_id: devices[C1] }, company, 'view');
      expect(r).toMatchObject({ ok: false });
      expect(r.rows).toBeUndefined();
    }
    // coordinator 2 cannot read coordinator 1's company
    await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${C2}', 'verified')`);
    await call('svc_coord_password_changed', { uid: C2 });
    const e2 = await call('svc_device_enroll', { uid: C2 }, JSON.stringify(KEY(2)), THUMB(2), 'C2 home');
    devices[C2] = e2.device_id;
    expect(await call('svc_coord_applicants', { uid: C2, device_id: devices[C2] }, 'Commotion', 'export')).toEqual({ ok: false, reason: 'company' });
    expect((await call('svc_coord_applicants', { uid: C2, device_id: devices[C2] }, 'siemens healthineers', 'export')).rows).toHaveLength(1);
  });
  it('the dashboard has aggregates and assigned companies only, no identities', async () => {
    const d = await call('svc_coord_dashboard', { uid: C1, device_id: devices[C1] });
    const blob = JSON.stringify(d);
    expect(blob).not.toMatch(/CL25M|Alpha|Beta|Gamma|private note|student_id/);
    expect(d.companies.map((c: any) => c.company)).toEqual(['Commotion', 'Philips']);
    expect(d.companies.find((c: any) => c.company === 'Commotion').applicants).toBe(3);
    expect(d.stats.find((s: any) => s.company_key === 'commotion').students).toBe(3);
    expect(d.upcoming).toEqual([]); // 2035 is outside the 45-day window
  });
  it('coordinators have no direct path to tables, private data or admin functions', async () => {
    const c: Who = { role: 'authenticated', uid: C1, aal: 'aal2' };
    expect(await as(c, 'select id, roll_number from public.students')).toHaveLength(0);
    expect(await as(c, 'select id from public.applications')).toHaveLength(0);
    await expect(as(c, 'select * from private.audit_events')).rejects.toThrow(/permission denied/);
    await expect(as(c, 'select * from private.coordinator_devices')).rejects.toThrow(/permission denied/);
    for (const q of [
      'select * from public.admin_audit_events()', 'select * from public.admin_security_alerts()',
      'select * from public.admin_coordinators()', 'select * from public.admin_student_names()',
      'select * from public.admin_credential_status()', 'select * from public.admin_outreach()',
      `select public.admin_coordinator_assign('${C1}', array['GE Healthcare'])`,
      `select public.admin_coordinator_set_suspended('${C2}', true)`,
      `select public.admin_coordinator_device('${C1}', true)`,
    ]) {
      await expect(as(c, q)).rejects.toThrow(/Not authorized/);
    }
    for (const q of [
      `select public.svc_coord_dashboard('{}'::jsonb)`, `select public.svc_coordinator_status('{}'::jsonb)`,
      `select public.svc_log_event(null, 'x.y', 'success', null, null, null)`, `select public.find_user_id_by_email('a@x.org')`,
      `select public.admin_grant_team('outsider@x.org')`, `select public.revoke_user_sessions('${C2}')`,
    ]) {
      await expect(as(c, q)).rejects.toThrow(/permission denied/);
    }
    await expect(as(c, `update public.team_members set suspended_at = null, must_change_password = false`)).rejects.toThrow(/permission denied/);
    await expect(as(c, `insert into public.admins (user_id) values ('${C1}')`)).rejects.toThrow(/permission denied/);
  });
  it('outreach records: assigned company only, validated, visible to the admin', async () => {
    const ok = await call('svc_coord_outreach_update', { uid: C1, device_id: devices[C1] }, 'commotion',
      JSON.stringify({ outreach_status: 'contacted', last_contact: '2026-10-28', next_action: 'Confirm test slot' }));
    expect(ok.ok).toBe(true);
    expect(await call('svc_coord_outreach_update', { uid: C1, device_id: devices[C1] }, 'GE Healthcare', JSON.stringify({ outreach_status: 'contacted' }))).toEqual({ ok: false, reason: 'company' });
    expect(await call('svc_coord_outreach_update', { uid: C1, device_id: devices[C1] }, 'Commotion', JSON.stringify({ outreach_status: 'hacked' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await call('svc_coord_outreach_update', { uid: C1, device_id: devices[C1] }, 'Commotion', JSON.stringify({ last_contact: 'yesterday' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await call('svc_coord_outreach_update', { uid: C1, device_id: devices[C1] }, 'Commotion', JSON.stringify({ assessment_date: '31/12/2026' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await call('svc_coord_outreach_update', { uid: C1, device_id: devices[C1] }, 'Commotion', JSON.stringify({ next_action: 'x'.repeat(301) }))).toEqual({ ok: false, reason: 'invalid' });
    const rows = await as<{ company: string; outreach_status: string; next_action: string; coordinators: string[] }>(admin, 'select * from public.admin_outreach()');
    const c = rows.find((r) => r.company === 'Commotion')!;
    expect(c).toMatchObject({ outreach_status: 'contacted', next_action: 'Confirm test slot' });
    expect(c.coordinators).toEqual(['coord.one@example.org']);
  });
});

describe('"All companies" option and the upcoming list', () => {
  it('a coordinator with All companies can list any company; upcoming shows date, company and stage only', async () => {
    await db.exec(`update public.applications set test_date = current_date + 3, application_stage = 'assessment_scheduled'
                    where company_name = 'Siemens Healthineers'`);
    await db.exec(`update public.applications set test_date = current_date + 5, application_stage = 'rejected'
                    where company_name = 'GE Healthcare'`);
    expect(await call('svc_coord_applicants', { uid: C2, device_id: devices[C2] }, 'GE Healthcare', 'view')).toMatchObject({ ok: false, reason: 'company' });
    await as(admin, `select public.admin_coordinator_assign($1, $2)`, [C2, ['*']]);
    const r = await call('svc_coord_applicants', { uid: C2, device_id: devices[C2] }, 'GE Healthcare', 'view');
    expect(r.ok).toBe(true);
    expect(r.rows.map((x: any) => x.roll_number)).toEqual(['CL25M003']);
    const d = await call('svc_coord_dashboard', { uid: C2, device_id: devices[C2] });
    expect(d.all_companies).toBe(true);
    expect(d.companies.map((c: any) => c.company).sort()).toEqual(['Commotion', 'GE Healthcare', 'Philips', 'Siemens Healthineers']);
    expect(d.upcoming).toEqual([{ company_key: expect.any(String), company: 'Siemens Healthineers', date: expect.any(String), stage: 'assessment_scheduled' }]);
    expect(JSON.stringify(d)).not.toMatch(/CL25M|Alpha|Beta|Gamma/);
    const ok = await call('svc_coord_outreach_update', { uid: C2, device_id: devices[C2] }, 'GE Healthcare', JSON.stringify({ outreach_status: 'contacted' }));
    expect(ok.ok).toBe(true);
    const out = await as<{ company: string; coordinators: string[] }>(admin, 'select * from public.admin_outreach()');
    expect(out.map((o) => o.company)).not.toContain('All companies');
    expect(out.find((o) => o.company === 'GE Healthcare')?.coordinators).toContain('coord.two@example.org');
    // back to one company
    await as(admin, `select public.admin_coordinator_assign($1, $2)`, [C2, ['Siemens Healthineers']]);
    expect(await call('svc_coord_applicants', { uid: C2, device_id: devices[C2] }, 'GE Healthcare', 'view')).toMatchObject({ ok: false, reason: 'company' });
  });
});

describe('rate limits, audit trail and alerts', () => {
  beforeEach(async () => {
    await db.exec(`delete from private.rate_events`);
  });
  it('exports are rate-limited per account; changing request metadata does not help', async () => {
    await db.exec(`update private.settings set rate_export_per_hour = 4`);
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await call('svc_coord_applicants', { uid: C2, device_id: devices[C2], ip: `198.51.100.${i}`, req: `r${i}` }, 'Siemens Healthineers', 'export');
      results.push(r.ok);
    }
    expect(results).toEqual([true, true, true, true, false, false]);
    await db.exec(`update private.settings set rate_export_per_hour = 10`);
  });
  it('records successful and denied access with the right actor and company', async () => {
    const ev = await audit(`actor_id = '${C2}' and event_type = 'coord.export'`);
    expect(ev.filter((e) => e.outcome === 'success').length).toBeGreaterThanOrEqual(4);
    expect(ev.find((e) => e.outcome === 'denied' && e.detail.reason === 'company')).toMatchObject({ company_key: 'commotion' });
    expect(ev.find((e) => e.outcome === 'denied' && e.detail.reason === 'rate')).toBeTruthy();
    expect(ev.every((e) => e.actor_role === 'coordinator')).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/Alpha|Beta|Gamma|CL25M00/);
  });
  it('repeated exports raise an alert for that coordinator only', async () => {
    const a = (await db.query<{ rule: string; actor_id: string }>(`select rule, actor_id from private.security_alerts where rule = 'repeated_exports'`)).rows;
    expect(a).toEqual([{ rule: 'repeated_exports', actor_id: C2 }]);
  });
  it('access across many companies raises an alert', async () => {
    const many = ['Alpha Co', 'Bravo Co', 'Charlie Co', 'Delta Co', 'Echo Co', 'Foxtrot Co'];
    await as(admin, `select public.admin_coordinator_assign($1, $2)`, [C3, many]);
    for (const c of many) expect((await call('svc_coord_applicants', { uid: C3, device_id: devices[C3] }, c, 'view')).ok).toBe(true);
    const a = (await db.query(`select rule from private.security_alerts where actor_id = '${C3}' and rule = 'many_companies'`)).rows;
    expect(a).toHaveLength(1);
  });
  it('repeated denials, failed sign-ins and unknown devices raise alerts', async () => {
    for (let i = 0; i < 10; i++) await call('svc_coord_applicants', { uid: C2, device_id: devices[C2] }, 'GE Healthcare', 'view');
    for (let i = 0; i < 5; i++) await svc(`select public.svc_staff_login_result('coord.two@example.org', null, false, '192.0.2.1', 'ua', 'r')`);
    await svc(`select public.svc_log_event($1, 'device.unrecognized', 'denied', '192.0.2.9', 'ua', 'r')`, [C2]);
    const rules = (await db.query<{ rule: string }>(`select distinct rule from private.security_alerts where actor_id = '${C2}' order by 1`)).rows.map((r) => r.rule);
    expect(rules).toEqual(expect.arrayContaining(['login_failures', 'repeated_denials', 'unregistered_device']));
  });
  it('staff sign-in is throttled per account after repeated failures', async () => {
    const g = await svc<{ g: { allowed: boolean } }>(`select public.svc_staff_login_gate('coord.two@example.org', '192.0.2.50') as g`);
    expect(g[0].g.allowed).toBe(true); // rate_events were cleared before this test
    for (let i = 0; i < 5; i++) await svc(`select public.svc_staff_login_result('coord.two@example.org', null, false, '192.0.2.50', 'ua', 'r')`);
    const g2 = await svc<{ g: { allowed: boolean } }>(`select public.svc_staff_login_gate('COORD.TWO@example.org ', '192.0.2.99') as g`);
    expect(g2[0].g.allowed).toBe(false);
  });
  it('sign-in results map accounts to the right portal', async () => {
    const role = async (uid: string) =>
      (await svc<{ r: { role: string } }>(`select public.svc_staff_login_result(null, $1, true, 'ip', 'ua', 'r') as r`, [uid]))[0].r.role;
    expect(await role(ADMIN)).toBe('admin');
    expect(await role(C1)).toBe('coordinator');
    expect(await role(SA)).toBe('none');
    expect(await role(OUT)).toBe('none');
    await as(admin, `select public.admin_coordinator_set_suspended($1, true)`, [C2]);
    expect(await role(C2)).toBe('none');
    await as(admin, `select public.admin_coordinator_set_suspended($1, false)`, [C2]);
  });
  it('audit events cannot be changed or deleted, even by the server role', async () => {
    await expect(svc(`update private.audit_events set outcome = 'success'`)).rejects.toThrow(/permission denied/);
    await expect(svc(`delete from private.audit_events`)).rejects.toThrow(/permission denied/);
    await expect(db.exec(`update private.audit_events set outcome = 'success' where id = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(db.exec(`delete from private.audit_events where id = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(db.exec(`truncate private.audit_events`)).rejects.toThrow(/cannot be truncated/);
  });
  it('the administrator can read events and alerts and review an alert', async () => {
    const ev = await as<{ event_type: string; actor_email: string }>(admin, `select * from public.admin_audit_events(500)`);
    expect(ev.some((e) => e.event_type === 'coord.export' && e.actor_email === 'coord.two@example.org')).toBe(true);
    const al = await as<{ id: number; status: string }>(admin, `select * from public.admin_security_alerts('open')`);
    expect(al.length).toBeGreaterThan(0);
    await as(admin, `select public.admin_review_alert($1, 'reviewed', 'expected bulk export for drive')`, [al[0].id]);
    const after = await as<{ status: string }>(admin, `select * from public.admin_security_alerts()`);
    expect(after.find((x: any) => x.id === al[0].id)?.status).toBe('reviewed');
    expect((await audit(`event_type = 'admin.alert_reviewed'`))[0]).toMatchObject({ actor_id: ADMIN });
  });
});

describe('function privileges', () => {
  it('no server-only function is callable from the browser roles', async () => {
    const rows = (await db.query<{ f: string; anon: boolean; auth: boolean }>(`
      select p.proname as f, has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as auth
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'svc\\_%' or p.proname in
         ('find_user_id_by_email','attempt_student_login','link_student_user','set_student_code','revoke_user_sessions','admin_grant_team'))`)).rows;
    expect(rows.length).toBeGreaterThan(15);
    for (const r of rows) expect({ f: r.f, anon: r.anon, auth: r.auth }).toEqual({ f: r.f, anon: false, auth: false });
  });
  it('anonymous visitors can call nothing that returns or changes data', async () => {
    const rows = (await db.query<{ f: string }>(`
      select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).rows.map((r) => r.f);
    // Only pure text helpers (company-name normalisation) remain callable anonymously.
    const allowed = new Set(['clean_text', 'company_key', 'osa_distance', 'same_company_key']);
    const unexpected = rows.filter((f) => !allowed.has(f));
    expect(unexpected).toEqual([]);
    await expect(as({ role: 'anon' }, `select * from public.submit_applications('[]'::jsonb)`)).rejects.toThrow(/permission denied/);
    await expect(as({ role: 'anon' }, `select * from public.admin_list_team()`)).rejects.toThrow(/permission denied/);
  });
});
