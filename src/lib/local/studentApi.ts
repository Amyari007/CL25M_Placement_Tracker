import { ApiError } from '../errors';
import type { ApplicationDraft, ApplicationRow, StudentRow } from '../types';
import { cleanText, getSession, load, normalizeCompany, publicStudent, randomId, save } from './store';
import { aggregateStats, companyMatchKey, sameCompany, type CompanyStat } from '../../../supabase/functions/_shared/analytics.ts';

/** Every call re-checks the signed-in student, mirroring the server rules. */
function me() {
  const sess = getSession();
  if (sess?.kind !== 'student') throw new ApiError('Your session has expired. Please sign in again.', 401);
  const store = load();
  const s = store.students.find((x) => x.id === sess.studentId);
  if (!s) throw new ApiError('Your session has expired. Please sign in again.', 401);
  return { store, s };
}

function clean(d: ApplicationDraft) {
  const company = cleanText(d.company_name);
  if (!company) throw new ApiError('Company name is required.', 400);
  return {
    company_name: company,
    normalized_company_name: normalizeCompany(company),
    test_date: d.test_date || null,
    role: cleanText(d.role),
    application_stage: d.application_stage,
    stage_is_default: d.stage_is_default,
    notes: d.notes.trim() || null,
  };
}

export async function updateMyName(_studentId: string, name: string): Promise<StudentRow> {
  const { store, s } = me();
  const n = cleanText(name);
  if (!n) throw new ApiError('Please enter your name.', 400);
  s.name = n;
  s.profile_completed_at ??= new Date().toISOString();
  s.last_activity_at = new Date().toISOString();
  save(store);
  return publicStudent(s);
}

export async function listMyApplications(): Promise<ApplicationRow[]> {
  const { store, s } = me();
  return store.applications.filter((a) => a.student_id === s.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function toPayload(d: ApplicationDraft) {
  return clean(d);
}

/** Mirrors public.submit_applications(): validate everything, then replace the list. */
export async function submitApplications(items: ApplicationDraft[]): Promise<ApplicationRow[]> {
  await new Promise((r) => setTimeout(r, 300));
  const { store, s } = me();
  if (items.length > 300) throw new ApiError('Too many companies (maximum 300)', 400);
  if (!items.length && !s.submitted_at) throw new ApiError('Add at least one company before submitting', 400);
  const cleaned = items.map(clean);
  cleaned.forEach((c, i) => {
    if (c.company_name.length > 120) throw new ApiError('Company names must be 120 characters or fewer', 400);
    if (!companyMatchKey(c.company_name)) throw new ApiError(`"${c.company_name}" is not a valid company name`, 400);
    const dup = cleaned.slice(0, i).find((p) => sameCompany(p.company_name, c.company_name));
    if (dup) throw new ApiError(`"${dup.company_name}" and "${c.company_name}" look like the same company — keep one`, 409);
  });
  const now = new Date().toISOString();
  const mine = store.applications.filter((a) => a.student_id === s.id);
  const others = store.applications.filter((a) => a.student_id !== s.id);
  const next: ApplicationRow[] = cleaned.map((c) => {
    const key = companyMatchKey(c.company_name);
    const prev = mine.find((a) => companyMatchKey(a.company_name) === key);
    if (prev) {
      const same = (Object.keys(c) as (keyof typeof c)[]).every((k) => prev[k] === c[k]);
      return same ? prev : { ...prev, ...c, updated_at: now };
    }
    return { id: randomId(), student_id: s.id, ...c, created_at: now, updated_at: now };
  });
  store.applications = [...others, ...next];
  s.submitted_at = now;
  s.last_activity_at = now;
  save(store);
  return [...next].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export interface StatsResult {
  rows: CompanyStat[];
  total: number;
  refreshedAt: Date;
}

export async function fetchCompanyStats(): Promise<StatsResult> {
  const sess = getSession();
  const store = load();
  const allowed =
    sess?.kind === 'admin' || sess?.kind === 'team' || (sess?.kind === 'student' && !!store.students.find((x) => x.id === sess.studentId)?.submitted_at);
  if (!allowed) throw new ApiError('Submit your applications to see batch statistics', 403);
  const { rows, total } = aggregateStats(store.applications);
  return { rows, total, refreshedAt: new Date() };
}
