/**
 * Single source of truth for every metric in the app.
 * Pure TypeScript — imported by both the web app and the export function,
 * so the dashboard and the Excel workbook can never disagree.
 */

export type Stage =
  | 'applied'
  | 'assessment_scheduled'
  | 'interview'
  | 'offer_received'
  | 'rejected'
  | 'withdrawn';

export const STAGES: Stage[] = [
  'applied',
  'assessment_scheduled',
  'interview',
  'offer_received',
  'rejected',
  'withdrawn',
];

export const STAGE_LABEL: Record<Stage, string> = {
  applied: 'Applied',
  assessment_scheduled: 'Assessment scheduled',
  interview: 'Interview',
  offer_received: 'Offer received',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/** Closed stages never count as "upcoming", even with a future date. */
export const CLOSED_STAGES: Stage[] = ['rejected', 'withdrawn'];

export const APP_TIMEZONE = 'Asia/Kolkata';

export interface StudentRow {
  id: string;
  roll_number: string;
  name: string | null;
  profile_completed_at: string | null;
  last_activity_at: string;
  /** Last successful "Submit Applications" (null = never submitted). */
  submitted_at?: string | null;
}

export interface ApplicationRow {
  id: string;
  student_id: string;
  company_name: string;
  normalized_company_name: string;
  role: string | null;
  application_stage: Stage;
  stage_is_default: boolean;
  test_date: string | null; // YYYY-MM-DD
  notes: string | null;
  company_key?: string;
  created_at: string;
  updated_at: string;
}

/** Mirrors the database: trim, collapse inner spaces, lower-case. */
export function normalizeCompany(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/* ------------------------------------------------------------------
 * Spelling-tolerant company matching
 * "Commotion", "commotion", " COMMOTION ", "Commotion Pvt. Ltd.",
 * "Comotion" and "Commotoin" all land in one basket.
 * ------------------------------------------------------------------ */

const LEGAL_SUFFIXES = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'india', 'technologies', 'technology', 'tech',
]);

/** Comparison key: case, spacing, punctuation, accents and legal suffixes removed. */
export function companyMatchKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  // Drop trailing legal/generic words ("Pvt Ltd", "India"), but never the whole name.
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join('');
}

/** Damerau-Levenshtein (optimal string alignment): swaps like "oi"↔"io" cost 1. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Typos allowed: none for very short names (GE vs GSK stay apart), then 1, then 2. */
function typoBudget(len: number): number {
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  return 2;
}

export function sameCompany(a: string, b: string): boolean {
  const ka = companyMatchKey(a);
  const kb = companyMatchKey(b);
  if (ka === kb) return true;
  if (!ka || !kb) return false;
  // Both names must share the first letter — avoids e.g. "Baxter" ≈ "Dexter".
  if (ka[0] !== kb[0]) return false;
  // Numbers are never typos: "Unit 1" and "Unit 2" stay apart.
  if (ka.replace(/\D/g, '') !== kb.replace(/\D/g, '')) return false;
  return editDistance(ka, kb) <= typoBudget(Math.min(ka.length, kb.length));
}

/**
 * Assigns every application to a company group. The most-used spelling
 * seeds each group, so a rare typo joins the common name, never the reverse.
 * Returns application id → group key (the seed's match key).
 */
export function companyGroups(apps: ApplicationRow[]): Map<string, string> {
  const counts = new Map<string, { n: number; first: string; sample: string }>();
  for (const a of apps) {
    const k = companyMatchKey(a.company_name) || a.normalized_company_name;
    const c = counts.get(k);
    if (c) {
      c.n++;
      if (Date.parse(a.created_at) < Date.parse(c.first)) c.first = a.created_at;
    } else counts.set(k, { n: 1, first: a.created_at, sample: a.company_name });
  }
  // Same order as private.company_groups() in SQL: most used, then earliest, then key.
  const t = (iso: string) => Date.parse(iso);
  const ordered = [...counts.entries()].sort((x, y) => y[1].n - x[1].n || t(x[1].first) - t(y[1].first) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const seeds: string[] = [];
  const keyToGroup = new Map<string, string>();
  for (const [k, info] of ordered) {
    const hit = seeds.find((s) => sameCompany(s, info.sample) || sameCompany(s, k));
    if (hit) keyToGroup.set(k, hit);
    else {
      seeds.push(k);
      keyToGroup.set(k, k);
    }
  }
  const out = new Map<string, string>();
  for (const a of apps) out.set(a.id, keyToGroup.get(companyMatchKey(a.company_name) || a.normalized_company_name)!);
  return out;
}

/** Today's date (YYYY-MM-DD) in the batch's timezone. */
export function todayISO(now: Date = new Date(), tz = APP_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isUpcoming(a: Pick<ApplicationRow, 'test_date' | 'application_stage'>, today: string): boolean {
  return !!a.test_date && a.test_date >= today && !CLOSED_STAGES.includes(a.application_stage);
}

export interface StudentSummary {
  total: number;
  upcoming: number;
  noTestDate: number;
}

export function studentSummary(apps: ApplicationRow[], today: string): StudentSummary {
  return {
    total: apps.length,
    upcoming: apps.filter((a) => isUpcoming(a, today)).length,
    noTestDate: apps.filter((a) => !a.test_date).length,
  };
}

export interface RosterRow {
  student: StudentRow;
  applications: number;
  upcoming: number;
  lastUpdated: string;
}

export function roster(students: StudentRow[], apps: ApplicationRow[], today: string): RosterRow[] {
  const byStudent = groupBy(apps, (a) => a.student_id);
  return [...students]
    .sort((a, b) => a.roll_number.localeCompare(b.roll_number))
    .map((s) => {
      const mine = byStudent.get(s.id) ?? [];
      return {
        student: s,
        applications: mine.length,
        upcoming: mine.filter((a) => isUpcoming(a, today)).length,
        lastUpdated: s.last_activity_at,
      };
    });
}

export interface BatchOverview {
  registeredStudents: number;
  profilesCompleted: number;
  studentsWithApplications: number;
  studentsWithoutApplications: number;
  totalApplications: number;
  uniqueCompanies: number;
  upcomingAssessments: number;
}

export function batchOverview(students: StudentRow[], apps: ApplicationRow[], today: string): BatchOverview {
  const withApps = new Set(apps.map((a) => a.student_id));
  const studentsWithApplications = students.filter((s) => withApps.has(s.id)).length;
  return {
    registeredStudents: students.length,
    profilesCompleted: students.filter((s) => !!s.profile_completed_at || !!s.name).length,
    studentsWithApplications,
    studentsWithoutApplications: students.length - studentsWithApplications,
    totalApplications: apps.length,
    uniqueCompanies: new Set(companyGroups(apps).values()).size,
    upcomingAssessments: apps.filter((a) => isUpcoming(a, today)).length,
  };
}

export interface CompanyMetric {
  /** Group key used for matching (case/spacing/punctuation/typos folded). */
  normalized: string;
  display: string;
  /** Every distinct spelling students used for this company. */
  spellings: string[];
  /** Application records (a student applying twice counts twice). */
  applications: number;
  /** Distinct students (a student applying twice counts once). */
  distinctStudents: number;
  /** Share of all application records, 0–100. */
  percentOfApplications: number;
  /** Share of all distinct student–company relationships, 0–100 (pie chart). */
  percentOfStudents: number;
}

/**
 * Display name = the most common spelling students used; ties go to the
 * earliest record. Sorted by applications desc, then name.
 */
export function companyMetrics(apps: ApplicationRow[]): CompanyMetric[] {
  const total = apps.length;
  const keyOf = companyGroups(apps);
  const groups = groupBy(apps, (a) => keyOf.get(a.id)!);
  const out: CompanyMetric[] = [];
  for (const [normalized, rows] of groups) {
    const spellings = new Map<string, { n: number; first: string }>();
    for (const r of rows) {
      const cur = spellings.get(r.company_name);
      if (cur) {
        cur.n++;
        if (Date.parse(r.created_at) < Date.parse(cur.first)) cur.first = r.created_at;
      } else spellings.set(r.company_name, { n: 1, first: r.created_at });
    }
    // Most-used spelling; on a tie prefer one with capitals ("Commotion" over "commotion").
    const caps = (t: string) => (/[A-Z]/.test(t) ? 1 : 0);
    const display = [...spellings.entries()].sort(
      (a, b) => b[1].n - a[1].n || caps(b[0]) - caps(a[0]) || Date.parse(a[1].first) - Date.parse(b[1].first),
    )[0][0];
    out.push({
      normalized,
      display,
      spellings: [...spellings.keys()].sort((a, b) => spellings.get(b)!.n - spellings.get(a)!.n),
      applications: rows.length,
      distinctStudents: new Set(rows.map((r) => r.student_id)).size,
      percentOfApplications: total ? (rows.length / total) * 100 : 0,
      percentOfStudents: 0,
    });
  }
  const totalRel = out.reduce((n, m) => n + m.distinctStudents, 0);
  for (const m of out) m.percentOfStudents = totalRel ? (m.distinctStudents / totalRel) * 100 : 0;
  return out.sort((a, b) => b.distinctStudents - a.distinctStudents || b.applications - a.applications || a.display.localeCompare(b.display));
}

export interface StageCount {
  stage: Stage;
  label: string;
  count: number;
  /** Records whose stage was never chosen by the student (stored default). */
  defaultCount: number;
}

export function stageDistribution(apps: ApplicationRow[]): StageCount[] {
  return STAGES.map((stage) => {
    const rows = apps.filter((a) => a.application_stage === stage);
    return { stage, label: STAGE_LABEL[stage], count: rows.length, defaultCount: rows.filter((r) => r.stage_is_default).length };
  });
}

export interface UpcomingItem {
  application: ApplicationRow;
  student: StudentRow | undefined;
}

export function upcomingAssessments(students: StudentRow[], apps: ApplicationRow[], today: string): UpcomingItem[] {
  const byId = new Map(students.map((s) => [s.id, s]));
  return apps
    .filter((a) => isUpcoming(a, today))
    .sort(
      (a, b) =>
        a.test_date!.localeCompare(b.test_date!) ||
        (byId.get(a.student_id)?.roll_number ?? '').localeCompare(byId.get(b.student_id)?.roll_number ?? ''),
    )
    .map((a) => ({ application: a, student: byId.get(a.student_id) }));
}

/**
 * Pie data — "How many students applied to each company?": distinct students
 * per company; top N + one "Other" slice so the total is preserved.
 * Denominator = all distinct student–company relationships.
 */
export function pieSlices(metrics: CompanyMetric[], topN = 8) {
  const top = metrics.slice(0, topN).map((m) => ({ key: m.normalized, name: m.display, value: m.distinctStudents, companies: 1 }));
  const rest = metrics.slice(topN);
  if (rest.length) {
    top.push({
      key: '__other__',
      name: `Other (${rest.length} ${rest.length === 1 ? 'company' : 'companies'})`,
      value: rest.reduce((s, m) => s + m.distinctStudents, 0),
      companies: rest.length,
    });
  }
  return top;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** What a student may see: company name, distinct students, percentage. Nothing else. */
export interface CompanyStat {
  company: string;
  students: number;
  percent: number;
}

export function aggregateStats(apps: ApplicationRow[]): { rows: CompanyStat[]; total: number } {
  const m = companyMetrics(apps);
  const total = m.reduce((n, x) => n + x.distinctStudents, 0);
  return {
    total,
    rows: m.map((x) => ({ company: x.display, students: x.distinctStudents, percent: Math.round(x.percentOfStudents * 10) / 10 })),
  };
}
