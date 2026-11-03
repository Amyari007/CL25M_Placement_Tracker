/**
 * Edge-function logic (coordinator-api, staff-login, admin-team) run in Node
 * against the real migrations in PGlite, with real WebCrypto device keys.
 * Only Supabase Auth itself is simulated (token → user/session/AAL).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { handleCoordinator, passwordProblem, type CoordinatorDeps } from '../supabase/functions/_shared/coordinator.ts';
import { handleStaffLogin } from '../supabase/functions/_shared/staffLogin.ts';
import { handleAdminSecurity } from '../supabase/functions/_shared/adminSecurity.ts';
import { canonical, newNonce, signMessage, type PublicJwk } from '../supabase/functions/_shared/device.ts';
import { buildCompanyWorkbook, buildWorkbook } from '../supabase/functions/_shared/workbook.ts';

let db: PGlite;
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = id(900);
const C1 = id(901);
const C2 = id(902);
const C3 = id(903);
const S = (n: number) => id(n);

async function rpc(fn: string, args: Record<string, unknown>) {
  const names = Object.keys(args);
  const vals = names.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  await db.exec('begin');
  try {
    await db.exec('set local role service_role');
    const r = await db.query<{ r: unknown }>(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals);
    await db.exec('commit');
    return r.rows[0]?.r ?? null;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}

// token "t:<uid>:<sid>:<aal>" stands in for a Supabase-verified access token
const token = (uid: string, aal = 'aal2', sid = uid) => `t:${uid}:${sid}:${aal}`;
const passwords: Record<string, string> = {};
let clock = Date.parse('2026-10-29T10:00:00Z');
const deps: CoordinatorDeps = {
  async verifyToken(t) {
    const [p, uid, sid, aal] = t.split(':');
    if (p !== 't' || !uid) return null;
    const email = (await db.query<{ email: string }>(`select email from auth.users where id = $1`, [uid])).rows[0]?.email ?? null;
    return { uid, sid, aal, email };
  },
  rpc,
  async setPassword(uid, pw) {
    passwords[uid] = pw;
  },
  async buildExport(company, rows, now) {
    const wb = buildCompanyWorkbook(ExcelJS, { company, rows, now });
    return new Uint8Array(await wb.xlsx.writeBuffer());
  },
  now: () => clock,
};

interface Device {
  priv: CryptoKey;
  pub: PublicJwk;
}
async function newDevice(): Promise<Device> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { priv: kp.privateKey, pub: { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! } };
}
async function signed(dev: Device | null, action: string, payload: unknown, sid: string, over: Partial<{ ts: number; nonce: string }> = {}) {
  const payloadText = JSON.stringify(payload ?? null);
  const ts = over.ts ?? clock;
  const nonce = over.nonce ?? newNonce();
  const body: Record<string, unknown> = { action, payload: payloadText };
  if (dev) body.auth = { ts, nonce, sig: await signMessage(dev.priv, await canonical(action, ts, nonce, sid, payloadText)) };
  return body;
}
async function post(fnHandler: (r: Request) => Promise<Response>, tok: string | null, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'user-agent': 'vitest-browser', 'x-real-ip': '203.0.113.20' };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return fnHandler(new Request('https://fn.local/coordinator-api', { method: 'POST', headers, body: JSON.stringify(body) }));
}
const api = (tok: string | null, body: unknown) => post((r) => handleCoordinator(r, deps), tok, body);
const call = async (uid: string, dev: Device | null, action: string, payload: unknown = null, aal = 'aal2') =>
  api(token(uid, aal), await signed(dev, action, payload, uid));

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync('tests/sql/supabase-stubs.sql', 'utf8'));
  await db.exec(`create publication supabase_realtime`);
  for (const f of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN}','admin@x.org'),
    ('${C1}','coord.one@example.org'),('${C2}','coord.two@example.org'),('${C3}','coord.three@example.org'),
    ('${S(1)}','cl25m001@students.invalid'),('${S(2)}','cl25m002@students.invalid')`);
  await db.exec(`insert into public.admins (user_id) values ('${ADMIN}')`);
  await db.exec(`update public.students set user_id='${S(1)}', name='Alpha Student' where roll_number='CL25M001'`);
  await db.exec(`update public.students set user_id='${S(2)}', name='Beta Student' where roll_number='CL25M002'`);
  const asStudent = async (uid: string, items: unknown[]) => {
    await db.exec('begin');
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await db.exec('set local role authenticated');
    await db.query('select * from public.submit_applications($1::jsonb)', [JSON.stringify(items)]);
    await db.exec('commit');
  };
  await asStudent(S(1), [{ company_name: 'Commotion', notes: '=HYPERLINK("http://evil","x")' }, { company_name: '=cmd|calc' }]);
  await asStudent(S(2), [{ company_name: 'commotion pvt ltd', test_date: '2026-11-05' }]);
  for (const [uid, email] of [[C1, 'coord.one@example.org'], [C2, 'coord.two@example.org'], [C3, 'coord.three@example.org']]) {
    await rpc('svc_coordinator_provision', { p_admin: ADMIN, p_uid: uid, p_email: email, p_ip: null, p_ua: null, p_request: null });
    await db.exec(`insert into auth.sessions (id, user_id) values ('${uid}', '${uid}') on conflict do nothing`);
  }
  // admin assigns companies (as the admin, through the browser function)
  await db.exec('begin');
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ADMIN, session_id: ADMIN, aal: 'aal1' })]);
  await db.exec('set local role authenticated');
  await db.query(`select public.admin_coordinator_assign($1, $2)`, [C1, ['Commotion', '=cmd|calc']]);
  await db.query(`select public.admin_coordinator_assign($1, $2)`, [C2, ['Philips']]);
  await db.exec('commit');
});

const dev1 = { current: null as Device | null };

describe('coordinator-api: full onboarding through the HTTP handler', () => {
  it('refuses requests without a valid token', async () => {
    expect((await api(null, { action: 'status' })).status).toBe(401);
    expect((await api('garbage', { action: 'status' })).status).toBe(401);
  });
  it('MFA → own password → device → data, in that order', async () => {
    expect(await (await call(C1, null, 'status', null, 'aal1')).json()).toMatchObject({ state: 'pin_setup' });
    await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${C1}', 'verified')`);
    expect(await (await call(C1, null, 'status', null, 'aal1')).json()).toMatchObject({ state: 'mfa_verify' });
    expect(await (await call(C1, null, 'status')).json()).toMatchObject({ state: 'password_change' });
    // data before the flow completes: refused
    const early = await call(C1, null, 'dashboard');
    expect(early.status).toBe(403);
    expect(await early.json()).toMatchObject({ state: 'password_change' });

    const weak = await call(C1, null, 'account.password', { password: 'short' });
    expect(weak.status).toBe(400);
    const withEmail = await call(C1, null, 'account.password', { password: 'coord.one-is-my-password' });
    expect(withEmail.status).toBe(400);
    const ok = await call(C1, null, 'account.password', { password: 'Correct-Horse-Battery-29' });
    expect(ok.status).toBe(200);
    expect(passwords[C1]).toBe('Correct-Horse-Battery-29');
    expect(await (await call(C1, null, 'status')).json()).toMatchObject({ state: 'device_enroll' });

    dev1.current = await newDevice();
    const enr = await call(C1, dev1.current, 'device.enroll', { publicKey: dev1.current.pub, label: 'Home laptop' });
    expect(enr.status).toBe(200);
    expect(await (await call(C1, dev1.current, 'status')).json()).toMatchObject({ state: 'ready' });
    expect((await call(C1, dev1.current, 'session.begin')).status).toBe(200);
    const dash = await call(C1, dev1.current, 'dashboard');
    expect(dash.status).toBe(200);
    const d = await dash.json();
    expect(d.companies.map((c: { company: string }) => c.company)).toEqual(['=cmd|calc', 'Commotion']);
    expect(JSON.stringify(d)).not.toMatch(/CL25M|Alpha|Beta/);
  });
  it('company applicant list: roll numbers only, assigned company only', async () => {
    const r = await call(C1, dev1.current, 'applicants', { company: 'COMMOTION' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.rows.map((x: { roll_number: string }) => x.roll_number)).toEqual(['CL25M001', 'CL25M002']);
    expect(JSON.stringify(j)).not.toMatch(/Alpha|Beta|HYPERLINK/);
    const no = await call(C1, dev1.current, 'applicants', { company: 'Philips' });
    expect(no.status).toBe(403);
    expect(await no.json()).toMatchObject({ reason: 'company' });
  });
  it('company export: a confidential, formula-safe .xlsx with roll numbers only', async () => {
    const r = await call(C1, dev1.current, 'export', { company: 'Commotion' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/applicants-commotion-2026-10-29\.xlsx/);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await r.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Applicants']);
    const ws = wb.getWorksheet('Applicants')!;
    const cells: string[] = [];
    ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value))));
    expect(cells.join(' ')).toMatch(/Confidential/);
    expect(cells).toEqual(expect.arrayContaining(['CL25M001', 'CL25M002', 'Roll number']));
    expect(cells.join(' ')).not.toMatch(/Alpha|Beta|HYPERLINK|notes/i);
    // the company named "=cmd|calc" is shown as text, not run as a formula
    const r2 = await call(C1, dev1.current, 'export', { company: '=cmd|calc' });
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(await r2.arrayBuffer());
    const a1 = wb2.getWorksheet('Applicants')!.getCell('A1');
    expect(a1.type).not.toBe(ExcelJS.ValueType.Formula);
    expect(String(a1.value)).toMatch(/^'=cmd\|calc/);
  });
  it('outreach update for an assigned company', async () => {
    const r = await call(C1, dev1.current, 'outreach.update', { company: 'Commotion', fields: { outreach_status: 'contacted', next_action: 'Send JD', role: 'admin' } });
    expect(r.status).toBe(200);
    expect((await r.json()).outreach).toMatchObject({ outreach_status: 'contacted', next_action: 'Send JD' });
    const bad = await call(C1, dev1.current, 'outreach.update', { company: 'Commotion', fields: { outreach_status: 'whatever' } });
    expect(bad.status).toBe(400);
  });
});

describe('coordinator-api: PIN route', () => {
  it('PIN setup and check through the HTTP handler (no authenticator app)', async () => {
    const r1 = await call(C3, null, 'status', null, 'aal1');
    expect(await r1.json()).toMatchObject({ state: 'pin_setup' });
    const weak = await call(C3, null, 'pin.set', { pin: '111111' }, 'aal1');
    expect(weak.status).toBe(400);
    expect((await call(C3, null, 'pin.set', { pin: '583920' }, 'aal1')).status).toBe(200);
    expect(await (await call(C3, null, 'status', null, 'aal1')).json()).toMatchObject({ state: 'password_change' });
    // a different sign-in session must type it again
    const sid = id(8888);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${sid}', '${C3}')`);
    const st = await api(token(C3, 'aal1', sid), await signed(null, 'status', null, sid));
    expect(await st.json()).toMatchObject({ state: 'pin_verify' });
    const bad = await api(token(C3, 'aal1', sid), await signed(null, 'pin.verify', { pin: '000000' }, sid));
    expect(bad.status).toBe(400);
    const ok = await api(token(C3, 'aal1', sid), await signed(null, 'pin.verify', { pin: '583920' }, sid));
    expect(ok.status).toBe(200);
  });
});

describe('coordinator-api: device-binding attacks', () => {
  it('unsigned requests from the right account are refused and flagged', async () => {
    const r = await call(C1, null, 'dashboard');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ state: 'device_unrecognized' });
    const st = await (await call(C1, null, 'status')).json();
    expect(st.state).toBe('device_unrecognized');
    const al = (await db.query(`select rule from private.security_alerts where actor_id = '${C1}' and rule = 'unregistered_device'`)).rows;
    expect(al).toHaveLength(1);
  });
  it('a different browser key (password + MFA known) is refused', async () => {
    const attacker = await newDevice();
    expect((await call(C1, attacker, 'dashboard')).status).toBe(403);
    expect((await call(C1, attacker, 'export', { company: 'Commotion' })).status).toBe(403);
    // and cannot register itself as a second device
    const enr = await call(C1, attacker, 'device.enroll', { publicKey: attacker.pub, label: 'other' });
    expect(enr.status).toBe(403);
  });
  it('a captured request cannot be replayed', async () => {
    const body = await signed(dev1.current, 'dashboard', null, C1);
    expect((await api(token(C1), body)).status).toBe(200);
    expect((await api(token(C1), body)).status).toBe(403);
  });
  it('old signatures (clock skew > 2 min) are refused', async () => {
    const body = await signed(dev1.current, 'dashboard', null, C1, { ts: clock - 5 * 60_000 });
    expect((await api(token(C1), body)).status).toBe(403);
  });
  it('a signature is bound to its sign-in session', async () => {
    const other = id(7777);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${other}', '${C1}')`);
    const body = await signed(dev1.current, 'dashboard', null, C1); // signed for session C1
    expect((await api(token(C1, 'aal2', other), body)).status).toBe(403);
    await db.exec(`delete from auth.sessions where id = '${other}'`);
  });
  it('a signature is bound to its payload (company cannot be swapped)', async () => {
    const body = await signed(dev1.current, 'applicants', { company: 'Commotion' }, C1);
    body.payload = JSON.stringify({ company: 'Philips' });
    expect((await api(token(C1), body)).status).toBe(403);
  });
  it('a signed request for one action cannot be reused for another', async () => {
    const body = await signed(dev1.current, 'applicants', { company: 'Commotion' }, C1);
    body.action = 'export';
    expect((await api(token(C1), body)).status).toBe(403);
  });
  it('AAL1 tokens are refused even when correctly signed', async () => {
    const r = await api(token(C1, 'aal1'), await signed(dev1.current, 'dashboard', null, C1));
    expect(r.status).toBe(403);
  });
  it('another coordinator cannot use this device key', async () => {
    await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${C2}', 'verified')`);
    await call(C2, null, 'account.password', { password: 'Another-Long-Passphrase-11' });
    const reuse = await call(C2, dev1.current, 'device.enroll', { publicKey: dev1.current!.pub, label: 'copy' });
    expect(reuse.status).toBe(403);
    expect((await call(C2, dev1.current, 'dashboard')).status).toBe(403);
  });
  it('suspension takes effect on the very next request', async () => {
    await db.exec(`update public.team_members set suspended_at = now() where user_id = '${C1}'`);
    const r = await call(C1, dev1.current, 'dashboard');
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ state: 'unavailable' });
    await db.exec(`update public.team_members set suspended_at = null where user_id = '${C1}'`);
    expect((await call(C1, dev1.current, 'dashboard')).status).toBe(200);
  });
  it('a revoked session stops working immediately', async () => {
    await db.exec(`delete from auth.sessions where id = '${C1}'`);
    const r = await call(C1, dev1.current, 'dashboard');
    expect(r.status).toBe(403);
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C1}', '${C1}')`);
  });
});

describe('staff-login', () => {
  const hashes: Record<string, string> = { 'admin@x.org': 'admin-pass-123456', 'coord.one@example.org': 'Correct-Horse-Battery-29', 'cl25m001@students.invalid': 'x' };
  const signOuts: string[] = [];
  const login = (email: string, password: string, ip = '198.51.100.1') =>
    handleStaffLogin(
      new Request('https://fn.local/staff-login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify({ email, password }) }),
      {
        rpc,
        async signIn(e, p) {
          if (hashes[e] !== p) return null;
          const uid = (await db.query<{ id: string }>(`select id from auth.users where email = $1`, [e])).rows[0].id;
          return { uid, access_token: `t:${uid}:${uid}:aal1`, refresh_token: 'r' };
        },
        async signOut(t) {
          signOuts.push(t);
        },
      },
    );
  it('admin and coordinators get tokens; others get a generic refusal and are signed out', async () => {
    const a = await login('admin@x.org', 'admin-pass-123456');
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ role: 'admin' });
    const c = await login('COORD.ONE@example.org ', 'Correct-Horse-Battery-29');
    expect(await c.json()).toMatchObject({ role: 'coordinator' });
    const s = await login('cl25m001@students.invalid', 'x');
    expect(s.status).toBe(403);
    expect(signOuts).toHaveLength(1);
  });
  it('wrong passwords and unknown accounts get the same message', async () => {
    const w = await login('admin@x.org', 'nope');
    const u = await login('nobody@x.org', 'nope');
    expect(w.status).toBe(401);
    expect(u.status).toBe(401);
    expect(await w.json()).toEqual(await u.json());
  });
  it('locks an account after 5 failures, from any IP', async () => {
    for (let i = 0; i < 5; i++) await login('coord.one@example.org', 'wrong', `198.51.100.${10 + i}`);
    const r = await login('coord.one@example.org', 'Correct-Horse-Battery-29', '198.51.100.99');
    expect(r.status).toBe(429);
    const ev = (await db.query(`select outcome from private.audit_events where event_type = 'auth.login' and actor_id = '${C1}'`)).rows;
    expect(ev.filter((e: any) => e.outcome === 'failure').length).toBeGreaterThanOrEqual(5);
  });
});

describe('admin-team (coordinator provisioning)', () => {
  const created: string[] = [];
  const sec = (who: string | null, body: unknown) =>
    handleAdminSecurity(new Request('https://fn.local/admin-team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), {
      requireAdmin: async () => (who === ADMIN ? { uid: ADMIN } : null),
      rpc,
      async findUserId(email) {
        return (await db.query<{ id: string }>(`select id from auth.users where lower(email) = $1`, [email])).rows[0]?.id ?? null;
      },
      async createUser(email) {
        const nid = id(950 + created.length);
        await db.query(`insert into auth.users (id, email) values ($1, $2)`, [nid, email]);
        created.push(email);
        return nid;
      },
      async setPassword(uid, pw) {
        passwords[uid] = pw;
      },
    });
  it('only the administrator can provision', async () => {
    expect((await sec(C1, { action: 'provision', email: 'x@y.org' })).status).toBe(403);
    expect((await sec(null, { action: 'reset_password', userId: C2 })).status).toBe(403);
  });
  it('reuses an existing account, replaces its password and forces rotation', async () => {
    const before = passwords[C3];
    const r = await sec(ADMIN, { action: 'provision', email: 'coord.three@example.org' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.tempPassword).toMatch(/^[A-Za-z0-9]{18}$/);
    expect(passwords[C3]).toBe(j.tempPassword);
    expect(passwords[C3]).not.toBe(before);
    expect(created).toEqual([]);
    const t = (await db.query(`select must_change_password from public.team_members where user_id = '${C3}'`)).rows[0];
    expect(t).toEqual({ must_change_password: true });
  });
  it('creates a missing account once', async () => {
    const r = await sec(ADMIN, { action: 'provision', email: 'new.coord@x.org' });
    expect(r.status).toBe(200);
    expect(created).toEqual(['new.coord@x.org']);
  });
  it('refuses student sign-ins and resets passwords with an audit trail', async () => {
    const s = await sec(ADMIN, { action: 'provision', email: 'cl25m001@students.invalid' });
    expect(s.status).toBe(400);
    const r = await sec(ADMIN, { action: 'reset_password', userId: C2 });
    expect(r.status).toBe(200);
    const ev = (await db.query(`select event_type, actor_id, target_id from private.audit_events where event_type like 'admin.coordinator%' order by id`)).rows;
    expect(ev).toEqual(expect.arrayContaining([
      { event_type: 'admin.coordinator_password_reset', actor_id: ADMIN, target_id: C2 },
      { event_type: 'admin.coordinator_provisioned', actor_id: ADMIN, target_id: C3 },
    ]));
    // the reset signed C2 out everywhere...
    expect(await (await call(C2, null, 'status')).json()).toMatchObject({ state: 'unavailable' });
    // ...and after signing in again, C2 must set a new password before getting data
    await db.exec(`insert into auth.sessions (id, user_id) values ('${C2}', '${C2}')`);
    expect(await (await call(C2, null, 'status')).json()).toMatchObject({ state: 'password_change' });
  });
});

describe('password rules and admin export safety', () => {
  it('password rules', () => {
    expect(passwordProblem('short', null)).toMatch(/12/);
    expect(passwordProblem('placement@123', null)).toMatch(/common/);
    expect(passwordProblem('aaaaaaaaaaaaaa', null)).toMatch(/simple/);
    expect(passwordProblem('my-coord.two-password', 'coord.two@example.org')).toMatch(/email/);
    expect(passwordProblem('Vellore-Chennai-Trivandrum', 'coord.two@example.org')).toBeNull();
  });
  it('the administrator workbook stores formula-like text as plain text', async () => {
    const wb = buildWorkbook(ExcelJS, {
      students: [{ id: 's', roll_number: 'CL25M001', name: '@SUM(A1)', profile_completed_at: null, last_activity_at: '2026-10-29T00:00:00Z' } as never],
      applications: [{ id: 'a', student_id: 's', company_name: '=cmd|calc', normalized_company_name: '=cmd|calc', role: null, application_stage: 'applied',
        stage_is_default: true, test_date: null, notes: '+HYPERLINK("x")', created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z' } as never],
      now: new Date('2026-10-29T10:00:00Z'),
    });
    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf);
    const values: unknown[] = [];
    wb2.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => {
      expect(c.type).not.toBe(ExcelJS.ValueType.Formula);
      values.push(c.value);
    })));
    expect(values).toEqual(expect.arrayContaining(["'=cmd|calc", "'+HYPERLINK(\"x\")", "'@SUM(A1)"]));
  });
});
