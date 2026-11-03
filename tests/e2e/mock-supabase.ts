/**
 * A small local stand-in for the Supabase platform, for browser tests.
 *
 *   * Database: the REAL migrations running in PGlite, called with the
 *     same roles/claims Supabase uses (anon, authenticated, service_role).
 *   * REST: the subset of PostgREST the app uses (select/eq/is/order/
 *     offset/limit, single-object responses, PATCH, rpc).
 *   * Auth: sessions with real session ids, refresh, global/local logout,
 *     TOTP MFA (RFC 6238) and AAL1/AAL2 tokens.
 *   * Edge functions: coordinator-api, staff-login and admin-team use the
 *     REAL shared handlers; student-login, admin-export and
 *     admin-credentials are simplified equivalents.
 * It is a test double, not a security boundary. Tokens are not signed.
 */
import http from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import ExcelJS from 'exceljs';
import { handleCoordinator } from '../../supabase/functions/_shared/coordinator.ts';
import { handleStaffLogin } from '../../supabase/functions/_shared/staffLogin.ts';
import { handleAdminSecurity } from '../../supabase/functions/_shared/adminSecurity.ts';
import { buildCompanyWorkbook, buildWorkbook, exportFilename } from '../../supabase/functions/_shared/workbook.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

/* --------------------------------------------------------------- base32 / TOTP */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Buffer {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, '')) {
    val = (val << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret: string, t = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/* ------------------------------------------------------------------- tokens */
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function makeJwt(claims: Record<string, unknown>) {
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.bW9jaw`;
}
function readJwt(t: string | undefined): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

export interface MockOptions {
  port: number;
  adminEmail: string;
  adminPassword: string;
}

export async function startMock(opts: MockOptions) {
  // Like PostgREST, return SQL dates as 'YYYY-MM-DD' text (timestamps become ISO strings via JSON).
  const db = new PGlite({ extensions: { pgcrypto }, parsers: { 1082: (v: string) => v } });
  await db.exec(readFileSync(`${ROOT}tests/sql/supabase-stubs.sql`, 'utf8'));
  await db.exec('drop trigger users_default_session on auth.users');
  await db.exec('create publication supabase_realtime');
  for (const f of readdirSync(`${ROOT}supabase/migrations`).sort()) await db.exec(readFileSync(`${ROOT}supabase/migrations/${f}`, 'utf8'));
  await db.exec(readFileSync(`${ROOT}supabase/prototype-codes.sql`, 'utf8'));

  const passwords = new Map<string, string>(); // email -> password
  const factors = new Map<string, { id: string; secret: string; status: 'unverified' | 'verified'; friendly_name: string }[]>();
  const refresh = new Map<string, { sid: string; uid: string; aal: string }>(); // refresh token -> session

  // one DB user at a time (PGlite is a single connection)
  let chain: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function as<T = any>(claims: Record<string, unknown> | null, role: string, sql: string, params: unknown[] = [], headers: Record<string, string> = {}) {
    return locked(async () => {
      await db.exec('begin');
      try {
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [String(claims?.sub ?? '')]);
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? { role })]);
        await db.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(headers)]);
        await db.exec(`set local role ${role}`);
        const r = await db.query<T>(sql, params);
        await db.exec('commit');
        return JSON.parse(JSON.stringify(r.rows)) as T[]; // wire format, as PostgREST sends it
      } catch (e) {
        await db.exec('rollback');
        throw e;
      }
    });
  }
  const owner = <T = any>(sql: string, params: unknown[] = []) => locked(async () => (await db.query<T>(sql, params)).rows);

  async function createUser(email: string, password?: string) {
    const id = randomUUID();
    await owner(`insert into auth.users (id, email) values ($1, $2)`, [id, email.toLowerCase()]);
    if (password) passwords.set(email.toLowerCase(), password);
    return id;
  }
  async function userJson(uid: string) {
    const u = (await owner<{ id: string; email: string }>(`select id, email from auth.users where id = $1`, [uid]))[0];
    const f = factors.get(uid) ?? [];
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {},
      factors: f.map((x) => ({ id: x.id, factor_type: 'totp', status: x.status, friendly_name: x.friendly_name, created_at: '', updated_at: '' })),
      created_at: '2026-10-01T00:00:00Z',
    };
  }
  async function newSession(uid: string, aal = 'aal1', sid?: string) {
    const sessionId = sid ?? randomUUID();
    if (!sid) await owner(`insert into auth.sessions (id, user_id, refreshed_at) values ($1, $2, now()::timestamp)`, [sessionId, uid]);
    else await owner(`update auth.sessions set refreshed_at = now()::timestamp where id = $1`, [sessionId]);
    await owner(`update auth.users set last_sign_in_at = now() where id = $1`, [uid]);
    const now = Math.floor(Date.now() / 1000);
    const user = await userJson(uid);
    const access_token = makeJwt({ sub: uid, session_id: sessionId, aal, amr: [{ method: aal === 'aal2' ? 'totp' : 'password', timestamp: now }],
      role: 'authenticated', email: user.email, exp: now + 3600, iat: now });
    const refresh_token = randomBytes(16).toString('hex');
    refresh.set(refresh_token, { sid: sessionId, uid, aal });
    return { access_token, refresh_token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user };
  }
  async function sessionAlive(claims: Record<string, any> | null) {
    if (!claims?.sub || !claims.session_id) return false;
    return (await owner(`select 1 from auth.sessions where id = $1 and user_id = $2`, [claims.session_id, claims.sub])).length === 1;
  }

  async function seedAdmin() {
    const id = await createUser(opts.adminEmail, opts.adminPassword);
    await owner(`insert into public.admins (user_id) values ($1)`, [id]);
    return id;
  }
  const ADMIN_ID = await seedAdmin();

  /* ------------------------------------------------------------- functions */
  const svcRpc = async (fn: string, args: Record<string, unknown>) => {
    const names = Object.keys(args);
    const vals = names.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    const r = await as<{ r: unknown }>({ role: 'service_role' }, 'service_role', `select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, vals);
    return r[0]?.r ?? null;
  };
  const verifyToken = async (token: string) => {
    const c = readJwt(token);
    if (!c?.sub || !(await sessionAlive(c))) return null;
    return { uid: c.sub as string, sid: c.session_id as string, aal: String(c.aal), email: (c.email as string) ?? null };
  };
  const isAdminToken = async (req: Request) => {
    const c = readJwt(req.headers.get('authorization')?.slice(7));
    if (!c) return null;
    const r = await as<{ a: boolean }>(c, 'authenticated', 'select public.is_admin() as a');
    return r[0]?.a ? { uid: c.sub as string, claims: c } : null;
  };

  const functions: Record<string, (req: Request) => Promise<Response>> = {
    'coordinator-api': (req) =>
      handleCoordinator(req, {
        verifyToken,
        rpc: svcRpc,
        async setPassword(uid, pw) {
          const email = (await owner<{ email: string }>(`select email from auth.users where id = $1`, [uid]))[0].email;
          passwords.set(email, pw);
        },
        async buildExport(company, rows, now) {
          return new Uint8Array(await buildCompanyWorkbook(ExcelJS, { company, rows, now }).xlsx.writeBuffer());
        },
        now: () => Date.now(),
      }),
    'staff-login': (req) =>
      handleStaffLogin(req, {
        rpc: svcRpc,
        async signIn(email, password) {
          if (passwords.get(email) !== password) return null;
          const uid = (await owner<{ id: string }>(`select id from auth.users where email = $1`, [email]))[0]?.id;
          if (!uid) return null;
          const s = await newSession(uid);
          return { uid, access_token: s.access_token, refresh_token: s.refresh_token };
        },
        async signOut(token) {
          const c = readJwt(token);
          if (c?.session_id) await owner(`delete from auth.sessions where id = $1`, [c.session_id]);
        },
      }),
    'admin-team': (req) =>
      handleAdminSecurity(req, {
        requireAdmin: async (r) => {
          const a = await isAdminToken(r);
          return a ? { uid: a.uid } : null;
        },
        rpc: svcRpc,
        async findUserId(email) {
          return (await owner<{ id: string }>(`select id from auth.users where lower(email) = $1`, [email]))[0]?.id ?? null;
        },
        createUser: (email, pw) => createUser(email, pw),
        async setPassword(uid, pw) {
          const email = (await owner<{ email: string }>(`select email from auth.users where id = $1`, [uid]))[0].email;
          passwords.set(email, pw);
        },
      }),
    async 'student-login'(req) {
      const body = await req.json();
      const roll = String(body.rollNumber ?? '').trim().toUpperCase();
      const r = (await as<any>({ role: 'service_role' }, 'service_role', `select * from public.attempt_student_login($1, $2, '127.0.0.1')`, [roll, String(body.accessCode ?? '')]))[0];
      if (r?.status !== 'ok') return Response.json({ error: 'invalid_credentials', message: 'That roll number and access code do not match.' }, { status: r?.status === 'throttled' ? 429 : 401 });
      let uid = r.user_id as string | null;
      if (!uid) {
        uid = await createUser(`${roll.toLowerCase()}@students.cl25m-tracker.invalid`);
        await as({ role: 'service_role' }, 'service_role', `select public.link_student_user($1, $2)`, [r.student_id, uid]);
      }
      const s = await newSession(uid!);
      return Response.json({ access_token: s.access_token, refresh_token: s.refresh_token });
    },
    async 'admin-export'(req) {
      const a = await isAdminToken(req);
      if (!a) return Response.json({ error: 'forbidden', message: 'This action is unavailable for your account.' }, { status: 403 });
      const students = await as<any>(a.claims, 'authenticated', 'select id, roll_number, profile_completed_at, last_activity_at from public.students order by roll_number');
      const names = await as<any>(a.claims, 'authenticated', 'select * from public.admin_student_names()');
      const byId = new Map(names.map((n: any) => [n.student_id, n.name]));
      const applications = await as<any>(a.claims, 'authenticated', 'select * from public.applications order by created_at');
      const now = new Date();
      const wb = buildWorkbook(ExcelJS, { students: students.map((s: any) => ({ ...s, name: byId.get(s.id) ?? null })), applications, now });
      await svcRpc('svc_log_event', { p_actor: a.uid, p_type: 'admin.export', p_outcome: 'success', p_ip: '127.0.0.1', p_ua: 'mock', p_request: 'mock', p_detail: {} });
      return new Response(new Uint8Array(await wb.xlsx.writeBuffer()), {
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${exportFilename(now)}"` },
      });
    },
    async 'admin-credentials'(req) {
      const a = await isAdminToken(req);
      if (!a) return Response.json({ error: 'forbidden', message: 'This action is unavailable for your account.' }, { status: 403 });
      const body = await req.json();
      const rotate = async (studentId: string) => {
        const code = String(Math.floor(100000 + Math.random() * 899999));
        await as({ role: 'service_role' }, 'service_role', `select public.set_student_code($1, $2, false)`, [studentId, code]);
        const s = (await owner<any>(`select roll_number, user_id from public.students where id = $1`, [studentId]))[0];
        if (s.user_id) await owner(`delete from auth.sessions where user_id = $1`, [s.user_id]);
        return { rollNumber: s.roll_number, code };
      };
      if (body.action === 'rotate') return Response.json(await rotate(body.studentId));
      if (body.action === 'rotate_all') {
        const ids = await owner<any>(`select id from public.students order by roll_number`);
        const codes = [];
        for (const s of ids) codes.push(await rotate(s.id));
        return Response.json({ codes });
      }
      return Response.json({ ok: true });
    },
  };

  /* ------------------------------------------------------------- REST */
  function claimsOf(req: http.IncomingMessage) {
    const auth = req.headers.authorization;
    return auth?.startsWith('Bearer ') ? readJwt(auth.slice(7)) : null;
  }
  function pgError(e: any) {
    const code = e?.code ?? 'XX000';
    return { status: code === '42501' ? 403 : 400, body: { code, message: e?.message ?? 'error', details: null, hint: null } };
  }
  const ident = (s: string) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error('bad identifier'), { code: 'PGRST100' });
    return `"${s}"`;
  };
  function where(url: URL, params: unknown[]) {
    const parts: string[] = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
      const [op, ...rest] = v.split('.');
      const val = rest.join('.');
      if (op === 'eq') parts.push(`${ident(k)} = $${params.push(val)}`);
      else if (op === 'is' && val === 'null') parts.push(`${ident(k)} is null`);
      else if (op === 'is' && val === 'true') parts.push(`${ident(k)} is true`);
      else throw Object.assign(new Error(`unsupported filter ${k}=${v}`), { code: 'PGRST100' });
    }
    return parts.length ? ` where ${parts.join(' and ')}` : '';
  }
  const cols = (sel: string | null) => (!sel || sel === '*' ? '*' : sel.split(',').map((c) => ident(c.trim())).join(', '));

  async function rest(req: http.IncomingMessage, url: URL, body: string) {
    const claims = claimsOf(req);
    const role = claims?.sub ? 'authenticated' : 'anon';
    const effective = claims?.sub ? claims : { role: 'anon' };
    const headers = { 'x-real-ip': '127.0.0.1', 'user-agent': String(req.headers['user-agent'] ?? '') };
    const m = /^\/rest\/v1\/(rpc\/)?([a-z_]+)$/.exec(url.pathname);
    if (!m) return { status: 404, body: { message: 'not found' } };
    const [, isRpc, name] = m;
    try {
      if (isRpc) {
        const args = body ? JSON.parse(body) : {};
        const names = Object.keys(args);
        const vals = names.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : Array.isArray(args[k]) && typeof args[k][0] === 'object' ? JSON.stringify(args[k]) : args[k]));
        const meta = await owner<{ retset: boolean; rettype: string }>(
          `select p.proretset as retset, t.typname as rettype from pg_proc p join pg_type t on t.oid = p.prorettype join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1`, [name]);
        if (!meta.length) return { status: 404, body: { message: 'function not found' } };
        const call = `public.${ident(name)}(${names.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
        if (meta[0].retset) return { status: 200, body: await as(effective, role, `select * from ${call}`, vals, headers) };
        const r = await as<{ r: unknown }>(effective, role, `select ${call} as r`, vals, headers);
        return { status: 200, body: meta[0].rettype === 'void' ? null : r[0].r };
      }
      const params: unknown[] = [];
      const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
      if (req.method === 'GET') {
        let sql = `select ${cols(url.searchParams.get('select'))} from public.${ident(name)}${where(url, params)}`;
        const order = url.searchParams.get('order');
        if (order) sql += ` order by ${order.split(',').map((o) => { const [c, dir] = o.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}`; }).join(', ')}`;
        if (url.searchParams.get('limit')) sql += ` limit ${Number(url.searchParams.get('limit'))}`;
        if (url.searchParams.get('offset')) sql += ` offset ${Number(url.searchParams.get('offset'))}`;
        const rows = await as(effective, role, sql, params, headers);
        if (single) return rows.length === 1 ? { status: 200, body: rows[0] } : { status: 406, body: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        return { status: 200, body: rows };
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse(body);
        const sets = Object.keys(patch).map((k) => `${ident(k)} = $${params.push(patch[k])}`).join(', ');
        const rows = await as(effective, role, `update public.${ident(name)} set ${sets}${where(url, params)} returning ${cols(url.searchParams.get('select'))}`, params, headers);
        if (single) return rows.length === 1 ? { status: 200, body: rows[0] } : { status: 406, body: { code: 'PGRST116', message: 'no rows' } };
        return { status: 200, body: rows };
      }
      return { status: 405, body: { message: 'method not allowed' } };
    } catch (e) {
      return pgError(e);
    }
  }

  /* ------------------------------------------------------------- auth */
  async function auth(req: http.IncomingMessage, url: URL, body: string) {
    const claims = claimsOf(req);
    const p = url.pathname.replace('/auth/v1', '');
    const unauthorized = { status: 403, body: { code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist', error_code: 'session_not_found' } };
    if (p === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const s = refresh.get(JSON.parse(body).refresh_token);
      if (!s || !(await owner(`select 1 from auth.sessions where id = $1`, [s.sid])).length) {
        return { status: 400, body: { code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' } };
      }
      return { status: 200, body: await newSession(s.uid, s.aal, s.sid) };
    }
    if (!claims?.sub || !(await sessionAlive(claims))) return unauthorized;
    const uid = claims.sub as string;
    if (p === '/user' && req.method === 'GET') return { status: 200, body: await userJson(uid) };
    if (p === '/logout') {
      const scope = url.searchParams.get('scope') ?? 'global';
      if (scope === 'global') await owner(`delete from auth.sessions where user_id = $1`, [uid]);
      else await owner(`delete from auth.sessions where id = $1`, [claims.session_id]);
      return { status: 204, body: null };
    }
    if (p === '/factors' && req.method === 'POST') {
      const b = JSON.parse(body);
      const f = { id: randomUUID(), secret: base32(randomBytes(20)), status: 'unverified' as const, friendly_name: b.friendly_name };
      factors.set(uid, [...(factors.get(uid) ?? []), f]);
      const uri = `otpauth://totp/CL25M:${claims.email}?secret=${f.secret}&issuer=CL25M`;
      return { status: 200, body: { id: f.id, type: 'totp', friendly_name: f.friendly_name, totp: { qr_code: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`, secret: f.secret, uri } } };
    }
    const fm = /^\/factors\/([0-9a-f-]+)(\/challenge|\/verify)?$/.exec(p);
    if (fm) {
      const list = factors.get(uid) ?? [];
      const f = list.find((x) => x.id === fm[1]);
      if (!f) return { status: 404, body: { code: 'mfa_factor_not_found', msg: 'Factor not found' } };
      if (req.method === 'DELETE') {
        factors.set(uid, list.filter((x) => x !== f));
        return { status: 200, body: { id: f.id } };
      }
      if (fm[2] === '/challenge') return { status: 200, body: { id: randomUUID(), type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 } };
      if (fm[2] === '/verify') {
        const { code } = JSON.parse(body);
        const ok = [-30_000, 0, 30_000].some((d) => totp(f.secret, Date.now() + d) === code);
        if (!ok) return { status: 422, body: { code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' } };
        if (f.status === 'unverified') {
          f.status = 'verified';
          await owner(`insert into auth.mfa_factors (id, user_id, status) values ($1, $2, 'verified')`, [f.id, uid]);
        }
        return { status: 200, body: await newSession(uid, 'aal2', claims.session_id) };
      }
    }
    return { status: 404, body: { msg: 'not found' } };
  }

  /* ------------------------------------------------------------- server */
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, accept, accept-profile, content-profile, prefer, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'content-disposition, content-range, retry-after',
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(200, cors).end('ok');
      return;
    }
    try {
      if (url.pathname.startsWith('/functions/v1/')) {
        const fn = functions[url.pathname.slice('/functions/v1/'.length)];
        if (!fn) return void res.writeHead(404, cors).end();
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        headers.set('x-real-ip', '127.0.0.1');
        const r = await fn(new Request(url, { method: req.method, headers, body: req.method === 'GET' ? undefined : body }));
        const h: Record<string, string> = Object.fromEntries(Object.entries(cors).map(([k, v]) => [k.toLowerCase(), v]));
        r.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
        res.writeHead(r.status, h).end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const out = url.pathname.startsWith('/rest/v1/') ? await rest(req, url, body) : url.pathname.startsWith('/auth/v1/') ? await auth(req, url, body) : { status: 404, body: null };
      if (out.status === 204) return void res.writeHead(204, cors).end();
      res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(out.body));
    } catch (e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ message: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(opts.port, '127.0.0.1', r));
  return {
    db,
    owner,
    ADMIN_ID,
    factors,
    passwords,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
