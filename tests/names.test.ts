/** Team members must never receive student names; admin and the student themself may. */
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';

let db: PGlite;
const ADMIN = '00000000-0000-0000-0000-000000000900';
const TEAM = '00000000-0000-0000-0000-000000000901';
const STU = '00000000-0000-0000-0000-000000000001';
const STU2 = '00000000-0000-0000-0000-000000000002';
type Who = { role: 'anon' | 'authenticated'; uid?: string; aal?: string };
async function as<T = Record<string, unknown>>(who: Who, sql: string) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.uid ?? '']);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who.uid, session_id: who.uid, aal: who.aal ?? 'aal1', role: who.role })]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<T>(sql);
    await db.exec('commit');
    return r.rows;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
const admin: Who = { role: 'authenticated', uid: ADMIN };
const team: Who = { role: 'authenticated', uid: TEAM };
const stu: Who = { role: 'authenticated', uid: STU };

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync('tests/sql/supabase-stubs.sql', 'utf8'));
  await db.exec(`create publication supabase_realtime`);
  for (const f of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN}','a@x.org'),('${TEAM}','team@x.org'),('${STU}','s1@x.org'),('${STU2}','s2@x.org')`);
  await db.exec(`insert into public.admins (user_id) values ('${ADMIN}')`);
  await db.exec(`insert into public.team_members (user_id, email) values ('${TEAM}','team@x.org')`);
  await db.exec(`update public.students set user_id='${STU}', name='Student One' where roll_number='CL25M001'`);
  await db.exec(`update public.students set user_id='${STU2}', name='Student Two' where roll_number='CL25M002'`);
  await as(stu, `select * from public.submit_applications('[{"company_name":"Philips"}]'::jsonb)`);
});

describe('names hidden from the placement team', () => {
  it('team member cannot read the name column', async () => {
    await expect(as(team, 'select name from public.students')).rejects.toThrow(/permission denied/);
    await expect(as(team, 'select * from public.students')).rejects.toThrow(/permission denied/);
  });
  it('coordinators get no rows from the tables directly (only the device-verified API)', async () => {
    expect(await as(team, 'select id, roll_number from public.students')).toHaveLength(0);
    expect(await as({ ...team, aal: 'aal2' }, 'select company_name from public.applications')).toHaveLength(0);
    await expect(as(team, 'select * from public.company_application_stats()')).rejects.toThrow(/Submit your applications/);
  });
  it('team member cannot get names through the functions', async () => {
    await expect(as(team, 'select * from public.admin_student_names()')).rejects.toThrow(/Not authorized/);
    expect(await as(team, 'select * from public.my_profile()')).toHaveLength(0);
  });
  it('administrator gets every name through admin_student_names()', async () => {
    const r = await as<{ name: string | null }>(admin, 'select * from public.admin_student_names()');
    expect(r).toHaveLength(15);
    expect(r.map((x) => x.name)).toEqual(expect.arrayContaining(['Student One', 'Student Two']));
  });
  it('a student gets only their own name', async () => {
    expect(await as(stu, 'select * from public.my_profile()')).toEqual([{ name: 'Student One' }]);
    await expect(as(stu, 'select * from public.admin_student_names()')).rejects.toThrow(/Not authorized/);
    await expect(as(stu, 'select name from public.students')).rejects.toThrow(/permission denied/);
  });
  it('a student can still change their own name', async () => {
    await as(stu, `update public.students set name='Student 1' where user_id = auth.uid()`);
    expect(await as(stu, 'select * from public.my_profile()')).toEqual([{ name: 'Student 1' }]);
  });
  it('anonymous visitors get nothing', async () => {
    await expect(as({ role: 'anon' }, 'select * from public.my_profile()')).rejects.toThrow(/permission denied/);
    await expect(as({ role: 'anon' }, 'select * from public.admin_student_names()')).rejects.toThrow(/permission denied/);
  });
  it('students rows are no longer broadcast as live updates', async () => {
    const r = (await db.query(`select tablename from pg_publication_tables where pubname='supabase_realtime'`)).rows;
    expect(r).toEqual([{ tablename: 'applications' }]);
  });
});
