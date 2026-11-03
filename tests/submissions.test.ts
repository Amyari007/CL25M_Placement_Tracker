/**
 * Feature-update acceptance tests (submission workflow, aggregate stats,
 * privacy, placement-team access). Runs ALL migrations on embedded
 * PostgreSQL (PGlite) and acts as each role through row-level security.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { aggregateStats, companyMatchKey, sameCompany, type ApplicationRow } from '../supabase/functions/_shared/analytics.ts';

let db: PGlite;
type Who = { role: 'anon' | 'authenticated'; uid?: string; aal?: string };
const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ADMIN = uid(900);
const TEAM = uid(901);
const OUTSIDER = uid(902);
const ROLLS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '015', '016'];
const stu = (i: number): Who => ({ role: 'authenticated', uid: uid(i + 1) }); // student index 0..14
const admin: Who = { role: 'authenticated', uid: ADMIN };
const team: Who = { role: 'authenticated', uid: TEAM };
const anon: Who = { role: 'anon' };

async function run<T = Record<string, unknown>>(who: Who, sql: string, params: unknown[] = [], commit = true) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [who.uid ?? '']);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who.uid, session_id: who.uid, aal: who.aal ?? 'aal1', role: who.role })]);
    await db.exec(`set local role ${who.role}`);
    const r = await db.query<T>(sql, params);
    await db.exec(commit ? 'commit' : 'rollback');
    return r.rows;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
const submit = (who: Who, items: Array<Record<string, unknown> | string>) =>
  run(who, 'select * from public.submit_applications($1::jsonb)', [JSON.stringify(items.map((x) => (typeof x === 'string' ? { company_name: x } : x)))]);
const stats = (who: Who) =>
  run<{ company: string; students: number; percent: string; total_relationships: number }>(who, 'select * from public.company_application_stats()');
const countFor = async (who: Who, company: string) => (await stats(who)).find((r) => r.company === company)?.students ?? 0;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync('tests/sql/supabase-stubs.sql', 'utf8'));
  for (const f of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  await db.exec(readFileSync('supabase/prototype-codes.sql', 'utf8'));
  const users = [...ROLLS.map((_, i) => uid(i + 1)), ADMIN, TEAM, OUTSIDER];
  await db.exec(`insert into auth.users (id, email) values ${users.map((u, i) => `('${u}', 'user${i}@example.org')`).join(',')}`);
  await db.exec(`update auth.users set email = 'team@example.org' where id = '${TEAM}'`);
  await db.exec(`insert into public.admins (user_id) values ('${ADMIN}')`);
  for (let i = 0; i < ROLLS.length; i++) {
    await db.exec(`update public.students set user_id = '${uid(i + 1)}', name = 'Student ${ROLLS[i]}' where roll_number = 'CL25M${ROLLS[i]}'`);
  }
});

describe('submission workflow and live counts (tests 1–8)', () => {
  it('statistics are locked until the student has submitted once', async () => {
    await expect(stats(stu(0))).rejects.toThrow(/Submit your applications/);
  });
  it('an empty first submission is rejected', async () => {
    await expect(submit(stu(0), [])).rejects.toThrow(/at least one company/);
  });
  it('1–3. student A submits several companies; one applicant shows a count of one', async () => {
    const rows = await submit(stu(0), ['Commotion', 'Philips', { company_name: 'Medtronic', test_date: '2026-11-05', application_stage: 'interview' }]);
    expect(rows).toHaveLength(3);
    expect(await countFor(stu(0), 'Commotion')).toBe(1);
    const s = await stats(stu(0));
    expect(s.reduce((n, r) => n + r.students, 0)).toBe(s[0].total_relationships);
    expect(s[0].total_relationships).toBe(3);
  });
  it('4–5. student B applies to the same company (different spelling) → A sees 2 when returning', async () => {
    await submit(stu(1), ['  commotion pvt. ltd. ']);
    // "Student A returns later": a fresh session/transaction reading live data.
    expect(await countFor(stu(0), 'Commotion')).toBe(2);
    expect(await countFor(stu(1), 'Commotion')).toBe(2);
  });
  it('typos land in the same basket (Comotion → Commotion)', async () => {
    await submit(stu(2), ['Comotion', 'GE HealthCare']);
    expect(await countFor(stu(2), 'Commotion')).toBe(3);
    expect((await stats(stu(2))).map((r) => r.company)).not.toContain('Comotion');
  });
  it('6. saved data persists across sessions', async () => {
    const mine = await run(stu(0), 'select company_name from public.applications order by company_name');
    expect(mine.map((r) => r.company_name)).toEqual(['Commotion', 'Medtronic', 'Philips']);
  });
  it('7. resubmitting an unchanged list does not inflate counts or touch rows', async () => {
    const before = await run(stu(0), 'select id, updated_at from public.applications order by id');
    const statsBefore = await stats(stu(0));
    for (let i = 0; i < 3; i++)
      await submit(stu(0), ['Commotion', 'Philips', { company_name: 'Medtronic', test_date: '2026-11-05', application_stage: 'interview' }]);
    expect(await run(stu(0), 'select id, updated_at from public.applications order by id')).toEqual(before);
    expect(await stats(stu(0))).toEqual(statsBefore.map((r) => ({ ...r, refreshed_at: expect.anything() })) as never);
  });
  it('the same company twice in one list (any spelling) is rejected and nothing changes', async () => {
    const before = await run(stu(0), 'select * from public.applications order by id');
    await expect(submit(stu(0), ['Commotion', 'Philips', 'COMMOTION'])).rejects.toThrow(/look like the same company/);
    await expect(submit(stu(0), ['Commotion', 'Commotoin'])).rejects.toThrow(/look like the same company/);
    expect(await run(stu(0), 'select * from public.applications order by id')).toEqual(before);
  });
  it('8. editing and removing companies updates the counts', async () => {
    // A drops Philips, corrects nothing else, adds Stryker
    await submit(stu(0), ['Commotion', 'Medtronic', 'Stryker']);
    expect(await countFor(stu(0), 'Philips')).toBe(0);
    expect(await countFor(stu(0), 'Stryker')).toBe(1);
    // B removes Commotion entirely
    await submit(stu(1), ['Stryker']);
    expect(await countFor(stu(0), 'Commotion')).toBe(2);
    expect(await countFor(stu(0), 'Stryker')).toBe(2);
    // A student who has submitted can later clear their list
    await submit(stu(1), []);
    expect(await countFor(stu(0), 'Stryker')).toBe(1);
  });
  it('a correction to details (not the company) updates the row without double counting', async () => {
    const rows = await submit(stu(0), ['Commotion', { company_name: 'Medtronic', test_date: '2026-11-09', application_stage: 'offer_received' }, 'Stryker']);
    const med = rows.find((r) => r.company_name === 'Medtronic')!;
    expect(med.application_stage).toBe('offer_received');
    expect(await countFor(stu(0), 'Medtronic')).toBe(1);
  });
});

describe('privacy (tests 9–11)', () => {
  it('9. a student cannot read other students or their records', async () => {
    expect((await run(stu(0), 'select roll_number from public.students')).map((r) => r.roll_number)).toEqual(['CL25M001']);
    const apps = await run<{ student_id: string }>(stu(0), 'select student_id from public.applications');
    const me = (await run<{ id: string }>(stu(0), 'select id from public.students'))[0].id;
    expect(apps.every((a) => a.student_id === me)).toBe(true);
  });
  it('9. students cannot write to the table directly (must use Submit)', async () => {
    const other = (await db.query<{ id: string }>(`select id from public.students where roll_number='CL25M003'`)).rows[0].id;
    await expect(run(stu(0), `insert into public.applications (student_id, company_name) values ($1, 'X')`, [other])).rejects.toThrow(/permission denied/);
    await expect(run(stu(0), `delete from public.applications`)).rejects.toThrow(/permission denied/);
    await expect(run(stu(0), `update public.applications set notes = 'x'`)).rejects.toThrow(/permission denied/);
  });
  it('10. aggregate statistics contain no names, roll numbers or ids', async () => {
    const rows = await stats(stu(0));
    expect(Object.keys(rows[0]).sort()).toEqual(['company', 'percent', 'refreshed_at', 'students', 'total_relationships']);
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/CL25M|Student \d|0000-0000/);
  });
  it('11. unauthorized requests cannot reveal identities', async () => {
    await expect(stats(anon)).rejects.toThrow(/permission denied/);
    await expect(stats({ role: 'authenticated', uid: OUTSIDER })).rejects.toThrow(/Submit your applications/);
    await expect(run(stu(0), 'select * from private.company_groups()')).rejects.toThrow(/permission denied/);
    await expect(run(stu(0), 'select * from public.admin_list_team()')).rejects.toThrow(/Not authorized/);
    await expect(run(stu(0), `select public.admin_grant_team('user0@example.org')`)).rejects.toThrow(/permission denied/);
    await expect(run(stu(0), `select public.find_user_id_by_email('team@example.org')`)).rejects.toThrow(/permission denied/);
    await expect(run(stu(0), 'select user_id, email from public.team_members')).resolves.toHaveLength(0);
    await expect(run({ role: 'authenticated', uid: OUTSIDER }, 'select * from public.applications')).resolves.toHaveLength(0);
  });
});

describe('administrator and placement team (tests 12–14)', () => {
  it('12. the administrator sees company-wise applicant identities', async () => {
    const rows = await run<{ roll_number: string; company_name: string }>(
      admin,
      `select s.roll_number, a.company_name from public.applications a join public.students s on s.id = a.student_id
        where a.company_key = public.company_key('Commotion') or public.same_company_key(a.company_key, 'commotion') order by 1`,
    );
    expect(rows.map((r) => r.roll_number)).toEqual(['CL25M001', 'CL25M003']);
  });
  it('a signed-up account with no approval sees nothing', async () => {
    const outsider: Who = { role: 'authenticated', uid: TEAM };
    expect(await run(outsider, 'select id, roll_number from public.students')).toHaveLength(0);
    expect((await run(outsider, 'select public.is_staff() as ok'))[0]).toEqual({ ok: false });
  });
  it('13. an approved coordinator gets NO direct table access and no admin-only functions', async () => {
    await db.exec(`insert into public.team_members (user_id, email) values ('${TEAM}', 'team@example.org') on conflict (user_id) do update set revoked_at = null`);
    for (const who of [team, { ...team, aal: 'aal2' }]) {
      expect(await run(who, 'select id, roll_number from public.students')).toHaveLength(0);
      expect(await run(who, 'select * from public.applications')).toHaveLength(0);
      await expect(stats(who)).rejects.toThrow(/Submit your applications/);
    }
    await expect(run(team, 'select * from public.admin_credential_status()')).rejects.toThrow(/Not authorized/);
    await expect(run(team, 'select * from public.admin_list_team()')).rejects.toThrow(/Not authorized/);
    await expect(run(team, `select public.admin_revoke_team('${TEAM}')`)).rejects.toThrow(/Not authorized/);
    await expect(run(team, 'select * from public.admin_coordinators()')).rejects.toThrow(/Not authorized/);
    await expect(run(team, `select public.svc_coord_dashboard('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
    expect((await run(team, 'select public.is_admin() as a'))[0]).toEqual({ a: false });
    await expect(run(team, `select * from public.submit_applications('["X"]'::jsonb)`)).rejects.toThrow(/Not authorized/);
  });
  it('student accounts cannot be made coordinators', async () => {
    await db.exec('begin');
    await db.exec('set local role service_role');
    const r = await db.query<{ r: { reason: string } }>(
      `select public.svc_coordinator_provision($1, $2, 'user0@example.org', null, null, null) as r`, [ADMIN, uid(1)]);
    await db.exec('rollback');
    expect(r.rows[0].r.reason).toBe('student_account');
  });
  it('14. a removed coordinator is signed out and listed as removed', async () => {
    await db.exec(`insert into auth.sessions (user_id) values ('${TEAM}')`);
    await run(admin, `select public.admin_revoke_team('${TEAM}')`);
    expect((await db.query(`select count(*)::int n from auth.sessions where user_id = '${TEAM}'`)).rows[0]).toEqual({ n: 0 });
    const list = await run<{ status: string }>(admin, 'select * from public.admin_coordinators()');
    expect(list.find(() => true)?.status).toBe('removed');
  });
});

describe('integrity (tests 15–16) and JS/SQL agreement', () => {
  it('15. a failed submission (bad data) leaves saved records untouched', async () => {
    const before = await run(stu(0), 'select * from public.applications order by id');
    await expect(submit(stu(0), ['Commotion', { company_name: 'Bad', test_date: 'not-a-date' }])).rejects.toThrow();
    await expect(submit(stu(0), ['Commotion', { company_name: 'Bad', application_stage: 'hired' }])).rejects.toThrow();
    await expect(submit(stu(0), ['Commotion', { company_name: '   ' }])).rejects.toThrow(/company name/);
    await expect(submit(stu(0), ['Commotion', { company_name: 'x'.repeat(121) }])).rejects.toThrow(/120/);
    expect(await run(stu(0), 'select * from public.applications order by id')).toEqual(before);
  });

  it('16. many interleaved submissions produce exactly the right counts', async () => {
    // Deterministic pseudo-random interleaving of all 15 students, 200 submits.
    const pool = ['Commotion', 'commotion', 'Comotion', 'Philips', 'Phillips', 'GE HealthCare', 'Medtronic', 'Stryker', 'Abbott', 'AbbVie', 'Baxter', 'Siemens Healthineers', 'Terumo Penpol', 'Wipro GE', 'BD', 'GE'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const truth = new Map<number, string[]>();
    for (let k = 0; k < 200; k++) {
      const i = Math.floor(rnd() * 15);
      const picked: string[] = [];
      for (const c of pool) if (rnd() < 0.3 && !picked.some((p) => sameCompany(p, c))) picked.push(c);
      if (!picked.length) picked.push('Abbott');
      await submit(stu(i), picked);
      truth.set(i, picked);
    }
    // Ground truth: distinct students per (spelling-tolerant) company from each student's last list.
    const all = await db.query<ApplicationRow>('select * from public.applications');
    const expected = aggregateStats(all.rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString() })));
    const got = await stats(admin);
    expect(got.map((r) => [r.company, r.students])).toEqual(expected.rows.map((r) => [r.company, r.students]));
    expect(got[0].total_relationships).toBe(expected.total);
    // Each student's stored list equals their last submission (no leftovers, no duplicates).
    for (const [i, list] of truth) {
      const mine = await run<{ company_name: string }>(stu(i), 'select company_name from public.applications');
      expect(mine.map((r) => r.company_name).sort()).toEqual([...list].sort());
    }
  });

  it('SQL company_key() and JS companyMatchKey() agree', async () => {
    const names = ['Commotion Pvt. Ltd.', '  COMMOTION ', 'Johnson & Johnson MedTech', 'Café Coffee Day', 'GE-HealthCare', 'India', 'Tech Mahindra Technologies', 'L&T Technology Services', '3M India', 'B. Braun', 'Medtronic India Pvt Ltd', 'Abbott   Laboratories'];
    for (const n of names) {
      const sql = (await db.query<{ k: string }>('select public.company_key($1) k', [n])).rows[0].k;
      expect(sql).toBe(companyMatchKey(n));
    }
  });
});

