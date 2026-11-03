/**
 * Builds the three-sheet admin export. ExcelJS is passed in so the same
 * code runs in the Deno edge function and in Node tests.
 */
import {
  APP_TIMEZONE,
  type ApplicationRow,
  type StudentRow,
  STAGE_LABEL,
  companyMetrics,
  roster,
  todayISO,
} from './analytics.ts';
import { safeCell } from './sanitize.ts';

// Minimal structural type for the ExcelJS bits we use.
// deno-lint-ignore no-explicit-any
type ExcelJSLike = { Workbook: new () => any };

const NAVY = 'FF13213C';
const HEADER_FILL = 'FFE9ECF2';
const BORDER = 'FFD5DAE3';

/** ISO timestamp → Date carrying the IST wall-clock time (Excel has no zones). */
function toLocalWallClock(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')));
}

function dateOnly(ymd: string | null): Date | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

interface Col {
  header: string;
  key: string;
  width: number;
  fmt?: string;
}

// deno-lint-ignore no-explicit-any
function addSheet(wb: any, name: string, title: string, generated: string, cols: Col[], rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));

  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: NAVY } };
  ws.getCell('A2').value = `Generated ${generated} (IST) · Confidential — administrator export`;
  ws.getCell('A2').font = { name: 'Calibri', size: 10, color: { argb: 'FF5B6578' } };

  const header = ws.getRow(4);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: NAVY } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: NAVY } } };
  });
  header.height = 22;

  rows.forEach((r, idx) => {
    const row = ws.getRow(5 + idx);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = safeCell(r[c.key] ?? null) as never;
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'top', wrapText: c.key === 'notes' };
      cell.border = { bottom: { style: 'hair', color: { argb: BORDER } } };
      if (c.fmt) cell.numFmt = c.fmt;
    });
  });

  const lastRow = Math.max(4, 4 + rows.length);
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastRow, column: cols.length } };
  return ws;
}

export interface ExportInput {
  students: StudentRow[];
  applications: ApplicationRow[];
  now?: Date;
}

// deno-lint-ignore no-explicit-any
export function buildWorkbook(ExcelJS: ExcelJSLike, { students, applications, now = new Date() }: ExportInput): any {
  const today = todayISO(now);
  const generated = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(now);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CL25M Placement Tracker';
  wb.created = now;
  wb.title = 'CL25M Placement Tracker export';

  const byId = new Map(students.map((s) => [s.id, s]));
  const DT = 'dd mmm yyyy hh:mm';
  const D = 'dd mmm yyyy';

  // 1. Student Roster
  addSheet(
    wb,
    'Student Roster',
    'Student Roster',
    generated,
    [
      { header: 'Roll number', key: 'roll', width: 14 },
      { header: 'Student name', key: 'name', width: 28 },
      { header: 'Number of applications', key: 'apps', width: 14 },
      { header: 'Upcoming assessments', key: 'upcoming', width: 14 },
      { header: 'Last updated (IST)', key: 'updated', width: 20, fmt: DT },
    ],
    roster(students, applications, today).map((r) => ({
      roll: r.student.roll_number,
      name: r.student.name ?? '',
      apps: r.applications,
      upcoming: r.upcoming,
      updated: toLocalWallClock(r.lastUpdated),
    })),
  );

  // 2. Company Applications
  const appRows = [...applications]
    .sort(
      (a, b) =>
        (byId.get(a.student_id)?.roll_number ?? '').localeCompare(byId.get(b.student_id)?.roll_number ?? '') ||
        a.created_at.localeCompare(b.created_at),
    )
    .map((a) => {
      const s = byId.get(a.student_id);
      return {
        roll: s?.roll_number ?? '',
        name: s?.name ?? '',
        company: a.company_name,
        role: a.role ?? '',
        stage: STAGE_LABEL[a.application_stage] + (a.stage_is_default ? ' (default)' : ''),
        test: dateOnly(a.test_date),
        notes: a.notes ?? '',
        created: toLocalWallClock(a.created_at),
        updated: toLocalWallClock(a.updated_at),
      };
    });
  addSheet(
    wb,
    'Company Applications',
    'Company Applications',
    generated,
    [
      { header: 'Roll number', key: 'roll', width: 14 },
      { header: 'Student name', key: 'name', width: 26 },
      { header: 'Company name', key: 'company', width: 26 },
      { header: 'Role', key: 'role', width: 24 },
      { header: 'Application stage', key: 'stage', width: 22 },
      { header: 'Test date', key: 'test', width: 14, fmt: D },
      { header: 'Notes', key: 'notes', width: 40 },
      { header: 'Created (IST)', key: 'created', width: 20, fmt: DT },
      { header: 'Last updated (IST)', key: 'updated', width: 20, fmt: DT },
    ],
    appRows,
  );

  // 3. Company Analytics
  addSheet(
    wb,
    'Company Analytics',
    'Company Analytics',
    generated,
    [
      { header: 'Normalized company name (match key)', key: 'norm', width: 28 },
      { header: 'Display company name', key: 'display', width: 28 },
      { header: 'Total applications', key: 'apps', width: 14 },
      { header: 'Distinct students applying', key: 'students', width: 16 },
      { header: 'Percentage of total applications', key: 'pct', width: 18, fmt: '0.0%' },
      { header: 'Spellings grouped', key: 'spellings', width: 40 },
    ],
    companyMetrics(applications).map((m) => ({
      norm: m.normalized,
      display: m.display,
      apps: m.applications,
      students: m.distinctStudents,
      pct: m.percentOfApplications / 100,
      spellings: m.spellings.join('; '),
    })),
  );

  return wb;
}

export function exportFilename(now = new Date()): string {
  return `CL25M-placement-export-${todayISO(now)}.xlsx`;
}

/* ------------------------------------------------------------------ */
/* Coordinator export: ONE company, roll numbers and coordination fields */
/* ------------------------------------------------------------------ */
export interface CompanyApplicantRow {
  roll_number: string;
  stage: string;
  assessment_date: string | null;
  applied_on: string | null;
  updated_at: string | null;
}

export function companySlug(company: string): string {
  return (
    company
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'company'
  );
}

export function companyExportFilename(company: string, now = new Date()): string {
  return `applicants-${companySlug(company)}-${todayISO(now)}.xlsx`;
}

// deno-lint-ignore no-explicit-any
export function buildCompanyWorkbook(ExcelJS: ExcelJSLike, input: { company: string; rows: CompanyApplicantRow[]; now?: Date }): any {
  const now = input.now ?? new Date();
  const generated = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIMEZONE, dateStyle: 'medium', timeStyle: 'short' }).format(now);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CL25M Placement Tracker';
  wb.lastModifiedBy = 'CL25M Placement Tracker';
  wb.created = now;
  wb.modified = now;
  wb.title = 'Company applicants';
  wb.subject = '';
  wb.keywords = '';
  wb.description = 'Confidential: for CL25M placement coordination only.';
  const ws = addSheet(
    wb,
    'Applicants',
    `${String(safeCell(input.company))}: applicants`,
    generated,
    [
      { header: 'Roll number', key: 'roll_number', width: 14 },
      { header: 'Stage', key: 'stage', width: 24 },
      { header: 'Assessment date', key: 'assessment_date', width: 18, fmt: 'dd mmm yyyy' },
      { header: 'Applied on', key: 'applied_on', width: 16, fmt: 'dd mmm yyyy' },
    ],
    input.rows.map((r) => ({
      roll_number: r.roll_number,
      stage: STAGE_LABEL[r.stage as keyof typeof STAGE_LABEL] ?? r.stage,
      assessment_date: dateOnly(r.assessment_date),
      applied_on: dateOnly(r.applied_on),
    })),
  );
  ws.getCell('A2').value = `Generated ${generated} (IST) · Confidential: for CL25M placement coordination only. Do not forward.`;
  return wb;
}
