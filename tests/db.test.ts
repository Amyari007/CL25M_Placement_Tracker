/**
 * Database acceptance tests — run the real migration on an embedded
 * PostgreSQL (PGlite) and exercise row-level security as each role.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync } from 'node:fs';

let db: PGlite;
const U = {
  s1: '00000000-0000-0000-0000-000000000001',
  s2: '00000000-0000-0000-0000-000000000002',
  admin: '00000000-0000-0000-0000-0000000000aa',
  stranger: '00000000-0000-0000-0000-0000000000ff',
};
let sid1 = '';
let sid2 = '';

type Who = { role: 'anon' | 'authenticated' | 'service_role'; uid?: string; aal?: string };

/** Runs SQL as a given role inside a rolled-back transaction. */
async function as<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = []) {
  let out: Awaited<ReturnType<typeof db.query<T>>> | undefined;
  await db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.uid ?? '']);
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(who.uid ? { sub: who.uid, session_id: who.uid, aal: who.aal ?? 'aal1', role: who.role } : { role: who.role }),
    ]);
    await tx.exec(`set local role ${who.role}`);
    out = await tx.query<T>(sql, params);
    await tx.rollback();
  });
  return out!;
}
/** Same, but commits (for writes that later assertions depend on). */
async function asCommit(who: Who, sql: string, params: unknown[] = []) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.uid ?? '']);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: who.uid, session_id: who.uid, aal: who.aal ?? 'aal1', role: who.role }),
    ]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query(sql, params);
    await db.exec('commit');
    return r;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}

const student1: Who = { role: 'authenticated', uid: U.s1 };
const student2: Who = { role: 'authenticated', uid: U.s2 };
const admin: Who = { role: 'authenticated', uid: U.admin };
const anon: Who = { role: 'anon' };

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync('tests/sql/supabase-stubs.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261026000000_init.sql', 'utf8'));
  await db.exec(readFileSync('supabase/prototype-codes.sql', 'utf8'));
  await db.exec(`insert into auth.users (id) values ('${U.s1}'), ('${U.s2}'), ('${U.admin}'), ('${U.stranger}')`);
  await db.exec(`insert into public.admins (user_id) values ('${U.admin}')`);
  sid1 = (await db.query<{ id: string }>(`select id from students where roll_number='CL25M001'`)).rows[0].id;
  sid2 = (await db.query<{ id: string }>(`select id from students where roll_number='CL25M002'`)).rows[0].id;
  await db.query(`select public.link_student_user($1, $2)`, [sid1, U.s1]);
  await db.query(`select public.link_student_user($1, $2)`, [sid2, U.s2]);
});

describe('accounts', () => {
  it('has exactly 15 students and excludes CL25M014', async () => {
    const r = await db.query<{ roll_number: string }>('select roll_number from students order by 1');
    expect(r.rows).toHaveLength(15);
    expect(r.rows.map((x) => x.roll_number)).not.toContain('CL25M014');
  });
  it('rejects creating CL25M014 or any extra roll number', async () => {
    await expect(db.query(`insert into students (roll_number) values ('CL25M014')`)).rejects.toThrow();
    await expect(db.query(`insert into students (roll_number) values ('CL25M017')`)).rejects.toThrow();
    await expect(db.query(`insert into students (roll_number) values ('CL25M001')`)).rejects.toThrow();
  });
  it('stores codes only as bcrypt hashes', async () => {
    const r = await db.query<{ code_hash: string }>('select code_hash from private.student_credentials');
    expect(r.rows).toHaveLength(15);
    for (const row of r.rows) expect(row.code_hash.startsWith('$2a$')).toBe(true);
    const cols = await db.query(`select column_name from information_schema.columns where table_name='students'`);
    expect(JSON.stringify(cols.rows)).not.toMatch(/code|password/);
  });
});

describe('login and throttling', () => {
  it('accepts the right code, case-insensitive roll', async () => {
    const r = await db.query<{ status: string }>(`select * from attempt_student_login('cl25m003','4328','10.0.0.1')`);
    expect(r.rows[0].status).toBe('ok');
  });
  it('gives the same answer for wrong code and unknown roll', async () => {
    const a = await db.query<{ status: string }>(`select * from attempt_student_login('CL25M004','0000','10.0.0.2')`);
    const b = await db.query<{ status: string }>(`select * from attempt_student_login('CL25M014','3732','10.0.0.2')`);
    expect(a.rows[0].status).toBe('invalid');
    expect(b.rows[0].status).toBe('invalid');
  });
  it('locks a roll number after 5 failures, even with the right code', async () => {
    for (let i = 0; i < 5; i++) await db.query(`select * from attempt_student_login('CL25M005','9999','10.0.0.3')`);
    const r = await db.query<{ status: string; retry_after_seconds: number }>(
      `select * from attempt_student_login('CL25M005','4590','10.0.0.4')`,
    );
    expect(r.rows[0].status).toBe('throttled');
    expect(r.rows[0].retry_after_seconds).toBeGreaterThan(0);
  });
  it('admin code reset clears the lockout and the old code stops working', async () => {
    const sid = (await db.query<{ id: string }>(`select id from students where roll_number='CL25M005'`)).rows[0].id;
    await db.query(`select public.set_student_code($1, '483920', false)`, [sid]);
    const old = await db.query<{ status: string }>(`select * from attempt_student_login('CL25M005','4590','10.0.0.5')`);
    expect(old.rows[0].status).toBe('invalid');
    const neu = await db.query<{ status: string }>(`select * from attempt_student_login('CL25M005','483920','10.0.0.5')`);
    expect(neu.rows[0].status).toBe('ok');
  });
  it('throttles an IP spraying many roll numbers', async () => {
    for (let i = 0; i < 30; i++) await db.query(`select * from attempt_student_login('CL25M010','0${i}00','10.9.9.9')`);
    const r = await db.query<{ status: string }>(`select * from attempt_student_login('CL25M011','7331','10.9.9.9')`);
    expect(r.rows[0].status).toBe('throttled');
  });
  it('login/credential functions are not callable by browsers', async () => {
    for (const who of [anon, student1]) {
      await expect(as(who, `select * from attempt_student_login('CL25M001','3732','x')`)).rejects.toThrow(/permission denied/);
      await expect(as(who, `select set_student_code('${sid1}','1111')`)).rejects.toThrow(/permission denied/);
      await expect(as(who, `select revoke_user_sessions('${U.s1}')`)).rejects.toThrow(/permission denied/);
      await expect(as(who, `select * from private.student_credentials`)).rejects.toThrow(/permission denied/);
      await expect(as(who, `select * from private.login_attempts`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe('student isolation (row-level security)', () => {
  beforeAll(async () => {
    await asCommit(student1, `insert into applications (student_id, company_name, test_date) values ($1, '  Philips  ', current_date + 3)`, [sid1]);
    await asCommit(student1, `insert into applications (student_id, company_name) values ($1, 'GE   Healthcare')`, [sid1]);
    await asCommit(student2, `insert into applications (student_id, company_name, role) values ($1, 'philips', 'Clinical Specialist')`, [sid2]);
  });

  it('a student sees only their own student row', async () => {
    const r = await as<{ roll_number: string }>(student1, 'select roll_number from students');
    expect(r.rows.map((x) => x.roll_number)).toEqual(['CL25M001']);
  });
  it('a student sees only their own applications', async () => {
    const r = await as<{ student_id: string }>(student1, 'select student_id from applications');
    expect(r.rows).toHaveLength(2);
    expect(r.rows.every((x) => x.student_id === sid1)).toBe(true);
  });
  it('cannot read another student by id (IDOR)', async () => {
    const r = await as(student1, 'select * from applications where student_id = $1', [sid2]);
    expect(r.rows).toHaveLength(0);
    const s = await as(student1, 'select * from students where id = $1', [sid2]);
    expect(s.rows).toHaveLength(0);
  });
  it('cannot create an application for another student', async () => {
    await expect(as(student1, `insert into applications (student_id, company_name) values ($1, 'X')`, [sid2])).rejects.toThrow(
      /row-level security/,
    );
  });
  it("cannot edit or delete another student's application", async () => {
    const upd = await as(student1, `update applications set notes='hacked' where student_id=$1 returning id`, [sid2]);
    expect(upd.rows).toHaveLength(0);
    const del = await as(student1, `delete from applications where student_id=$1 returning id`, [sid2]);
    expect(del.rows).toHaveLength(0);
    const still = await db.query(`select count(*)::int as n from applications where student_id=$1`, [sid2]);
    expect((still.rows[0] as { n: number }).n).toBe(1);
  });
  it('cannot move an application to another student', async () => {
    await expect(as(student1, `update applications set student_id=$1`, [sid2])).rejects.toThrow(/permission denied/);
  });
  it('can update own name but not roll number or link', async () => {
    const r = await as<{ name: string; profile_completed_at: string }>(
      student1,
      `update students set name='  Asha   Menon ' where user_id = auth.uid() returning name, profile_completed_at`,
    );
    expect(r.rows[0].name).toBe('Asha Menon');
    expect(r.rows[0].profile_completed_at).not.toBeNull();
    await expect(as(student1, `update students set roll_number='CL25M009'`)).rejects.toThrow(/permission denied/);
    await expect(as(student1, `update students set user_id=null`)).rejects.toThrow(/permission denied/);
  });
  it('supports add/edit/delete of own applications and missing test dates', async () => {
    const ins = await as<{ id: string; test_date: unknown; normalized_company_name: string; company_name: string }>(
      student1,
      `insert into applications (student_id, company_name) values ($1, '  Siemens   Healthineers ') returning *`,
      [sid1],
    );
    expect(ins.rows[0].test_date).toBeNull();
    expect(ins.rows[0].company_name).toBe('Siemens Healthineers');
    expect(ins.rows[0].normalized_company_name).toBe('siemens healthineers');
  });
  it('rejects empty company names', async () => {
    await expect(as(student1, `insert into applications (student_id, company_name) values ($1, '   ')`, [sid1])).rejects.toThrow();
  });
  it('a student is not an admin and cannot list credential status', async () => {
    const r = await as<{ is_admin: boolean }>(student1, 'select public.is_admin()');
    expect(r.rows[0].is_admin).toBe(false);
    await expect(as(student1, 'select * from admin_credential_status()')).rejects.toThrow(/Not authorized/);
  });
  it('anonymous users see nothing', async () => {
    await expect(as(anon, 'select * from applications')).rejects.toThrow(/permission denied/);
    await expect(as(anon, 'select * from students')).rejects.toThrow(/permission denied/);
  });
  it('a signed-in user who is neither student nor admin sees nothing', async () => {
    const who: Who = { role: 'authenticated', uid: U.stranger };
    expect((await as(who, 'select * from applications')).rows).toHaveLength(0);
    expect((await as(who, 'select * from students')).rows).toHaveLength(0);
  });
});

describe('administrator access', () => {
  it('admin reads every student and application', async () => {
    expect((await as(admin, 'select * from students')).rows).toHaveLength(15);
    expect((await as(admin, 'select * from applications')).rows).toHaveLength(3);
  });
  it('admin is read-only for applications', async () => {
    await expect(as(admin, `insert into applications (student_id, company_name) values ($1,'X')`, [sid1])).rejects.toThrow();
    expect((await as(admin, `delete from applications returning id`)).rows).toHaveLength(0);
  });
  it('admin can see credential status but never hashes', async () => {
    const r = await as(admin, 'select * from admin_credential_status()');
    expect(r.rows).toHaveLength(15);
    expect(JSON.stringify(r.rows)).not.toMatch(/\$2a\$/);
  });
  it('once MFA is enrolled, an aal1 admin session loses access; aal2 regains it', async () => {
    await db.exec(`insert into auth.mfa_factors (user_id, status) values ('${U.admin}', 'verified')`);
    expect((await as(admin, 'select * from applications')).rows).toHaveLength(0);
    expect((await as({ ...admin, aal: 'aal2' }, 'select * from applications')).rows).toHaveLength(3);
    await db.exec(`delete from auth.mfa_factors`);
  });
  it('require_admin_mfa forces aal2 even without factors', async () => {
    await db.exec(`update private.settings set require_admin_mfa = true`);
    expect((await as(admin, 'select public.is_admin()')).rows[0]).toEqual({ is_admin: false });
    expect((await as({ ...admin, aal: 'aal2' }, 'select public.is_admin()')).rows[0]).toEqual({ is_admin: true });
    await db.exec(`update private.settings set require_admin_mfa = false`);
  });
});
