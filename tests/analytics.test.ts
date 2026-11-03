import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  batchOverview,
  companyMetrics,
  normalizeCompany,
  companyMatchKey,
  sameCompany,
  pieSlices,
  roster,
  stageDistribution,
  studentSummary,
  todayISO,
  upcomingAssessments,
  type ApplicationRow,
  type StudentRow,
} from '../supabase/functions/_shared/analytics.ts';
import { buildWorkbook } from '../supabase/functions/_shared/workbook.ts';

const TODAY = '2026-10-26';
const students: StudentRow[] = [
  { id: 'a', roll_number: 'CL25M001', name: 'Asha', profile_completed_at: 'x', last_activity_at: '2026-10-26T05:00:00Z' },
  { id: 'b', roll_number: 'CL25M002', name: 'Bala', profile_completed_at: 'x', last_activity_at: '2026-10-25T05:00:00Z' },
  { id: 'c', roll_number: 'CL25M003', name: null, profile_completed_at: null, last_activity_at: '2026-10-20T05:00:00Z' },
];
let n = 0;
function app(student_id: string, company: string, extra: Partial<ApplicationRow> = {}): ApplicationRow {
  n++;
  return {
    id: `app${n}`,
    student_id,
    company_name: company.trim().replace(/\s+/g, ' '),
    normalized_company_name: normalizeCompany(company),
    role: null,
    application_stage: 'applied',
    stage_is_default: true,
    test_date: null,
    notes: null,
    created_at: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    updated_at: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    ...extra,
  };
}
const apps: ApplicationRow[] = [
  app('a', 'Philips', { test_date: '2026-10-28', application_stage: 'assessment_scheduled', stage_is_default: false }),
  app('a', 'philips ', { role: 'Second role' }), // same student, same company, second record
  app('b', 'PHILIPS', { test_date: '2026-10-26' }), // today counts as upcoming
  app('b', 'GE  Healthcare', { test_date: '2026-10-01' }), // past
  app('b', 'Medtronic', { test_date: '2026-11-02', application_stage: 'rejected', stage_is_default: false }), // closed
];

describe('metrics', () => {
  it('normalizes capitalization and whitespace', () => {
    expect(normalizeCompany('  GE   Healthcare ')).toBe('ge healthcare');
  });
  it('distinguishes records, distinct students and unique companies', () => {
    const m = companyMetrics(apps);
    const philips = m.find((x) => x.normalized === 'philips')!;
    expect(philips.applications).toBe(3);
    expect(philips.distinctStudents).toBe(2); // student a counted once
    expect(philips.display).toBe('Philips');
    expect(philips.percentOfApplications).toBeCloseTo(60);
    expect(m.reduce((s, x) => s + x.percentOfApplications, 0)).toBeCloseTo(100);
  });
  it('pie slices count distinct students and sum to all student–company relationships, including "Other"', () => {
    const many = [...apps, ...Array.from({ length: 12 }, (_, i) => app('c', `Company ${i}`))];
    const metrics = companyMetrics(many);
    const slices = pieSlices(metrics, 8);
    const relationships = new Set(many.map((a) => `${a.student_id}|${a.normalized_company_name}`)).size;
    expect(slices.reduce((s, x) => s + x.value, 0)).toBe(relationships);
    expect(slices).toHaveLength(9);
    expect(metrics.find((m) => m.normalized === 'philips')!.distinctStudents).toBe(2); // student a twice → once
    expect(metrics.reduce((s, m) => s + m.percentOfStudents, 0)).toBeCloseTo(100);
  });
  it('overview counts', () => {
    const o = batchOverview(students, apps, TODAY);
    expect(o).toEqual({
      registeredStudents: 3,
      profilesCompleted: 2,
      studentsWithApplications: 2,
      studentsWithoutApplications: 1,
      totalApplications: 5,
      uniqueCompanies: 3,
      upcomingAssessments: 2,
    });
  });
  it('upcoming = date today or later, not rejected/withdrawn; sorted by date', () => {
    const u = upcomingAssessments(students, apps, TODAY);
    expect(u.map((x) => x.application.test_date)).toEqual(['2026-10-26', '2026-10-28']);
  });
  it('student summary and roster', () => {
    expect(studentSummary(apps.filter((a) => a.student_id === 'b'), TODAY)).toEqual({ total: 3, upcoming: 1, noTestDate: 0 });
    const r = roster(students, apps, TODAY);
    expect(r.map((x) => [x.student.roll_number, x.applications, x.upcoming])).toEqual([
      ['CL25M001', 2, 1],
      ['CL25M002', 3, 1],
      ['CL25M003', 0, 0],
    ]);
  });
  it('stage distribution reports stored defaults separately', () => {
    const d = stageDistribution(apps);
    expect(d.find((x) => x.stage === 'applied')).toMatchObject({ count: 3, defaultCount: 3 });
    expect(d.reduce((s, x) => s + x.count, 0)).toBe(apps.length);
  });
  it('today is computed in IST', () => {
    expect(todayISO(new Date('2026-10-25T19:00:00Z'))).toBe('2026-10-26');
  });
});

describe('spelling-tolerant company grouping', () => {
  it('treats case, spacing, punctuation and legal suffixes as the same company', () => {
    for (const v of ['commotion', 'COMMOTION', '  Commotion ', 'Commotion Pvt. Ltd.', 'Commotion Private Limited', 'Commotion India']) {
      expect(companyMatchKey(v)).toBe('commotion');
    }
    expect(companyMatchKey('Johnson & Johnson MedTech')).toBe(companyMatchKey('johnson and johnson medtech'));
    expect(companyMatchKey('GE-HealthCare')).toBe(companyMatchKey('GE Healthcare'));
  });
  it('absorbs small typos', () => {
    expect(sameCompany('Commotion', 'Comotion')).toBe(true);
    expect(sameCompany('Commotion', 'Commotoin')).toBe(true); // swapped letters
    expect(sameCompany('Philips', 'Phillips')).toBe(true);
    expect(sameCompany('Medtronic', 'Medtronics')).toBe(true);
    expect(sameCompany('Siemens Healthineers', 'Siemens Healthiners')).toBe(true);
  });
  it('keeps genuinely different companies apart', () => {
    expect(sameCompany('GE', 'GSK')).toBe(false);
    expect(sameCompany('Abbott', 'AbbVie')).toBe(false);
    expect(sameCompany('Baxter', 'Dexter')).toBe(false);
    expect(sameCompany('Stryker', 'Siemens')).toBe(false);
    expect(sameCompany('BD', 'GE')).toBe(false);
    expect(sameCompany('Company 1', 'Company 2')).toBe(false);
  });
  it('counts every spelling in one basket, named by the common spelling', () => {
    const rows = [
      app('a', 'Commotion'),
      app('b', 'commotion'),
      app('c', 'COMMOTION Pvt Ltd'),
      app('a', 'Comotion'), // same student again, typo
      app('b', 'Philips'),
    ];
    const m = companyMetrics(rows);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ display: 'Commotion', applications: 4, distinctStudents: 3 });
    expect(m[0].spellings).toEqual(expect.arrayContaining(['Commotion', 'commotion', 'COMMOTION Pvt Ltd', 'Comotion']));
    expect(batchOverview(students, rows, TODAY).uniqueCompanies).toBe(2);
  });
});

describe('excel export', () => {
  it('has three formatted, filterable sheets that match the data', async () => {
    const wb = buildWorkbook(ExcelJS, { students, applications: apps, now: new Date('2026-10-26T06:00:00Z') });
    const buf = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf);
    expect(back.worksheets.map((w) => w.name)).toEqual(['Student Roster', 'Company Applications', 'Company Analytics']);
    for (const ws of back.worksheets) {
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 4 });
      expect(ws.autoFilter).toBeTruthy();
      expect(String(ws.getCell('A2').value)).toMatch(/Generated 26 Oct 2026/);
    }
    const roster = back.getWorksheet('Student Roster')!;
    expect(roster.getRow(4).values).toEqual([
      undefined,
      'Roll number',
      'Student name',
      'Number of applications',
      'Upcoming assessments',
      'Last updated (IST)',
    ]);
    expect(roster.rowCount).toBe(4 + 3);
    const appsWs = back.getWorksheet('Company Applications')!;
    expect(appsWs.rowCount).toBe(4 + apps.length);
    const analytics = back.getWorksheet('Company Analytics')!;
    expect(analytics.getRow(5).values).toEqual([undefined, 'philips', 'Philips', 3, 2, 0.6, 'Philips; philips; PHILIPS']);
  });
});
