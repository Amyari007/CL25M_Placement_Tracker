import { supabase } from './supabase';
import type { ApplicationDraft, ApplicationRow, StudentRow } from './types';
import type { CompanyStat } from '../../supabase/functions/_shared/analytics.ts';

const STUDENT_COLS = 'id, roll_number, profile_completed_at, last_activity_at, submitted_at';

export async function updateMyName(studentId: string, name: string): Promise<StudentRow> {
  const { data, error } = await supabase.from('students').update({ name: name.trim() }).eq('id', studentId).select(STUDENT_COLS).single();
  if (error) throw error;
  const { data: prof, error: pErr } = await supabase.rpc('my_profile');
  if (pErr) throw pErr;
  return { ...(data as Omit<StudentRow, 'name'>), name: (prof as { name: string | null }[])?.[0]?.name ?? null };
}

export async function listMyApplications(): Promise<ApplicationRow[]> {
  // RLS returns only the signed-in student's rows.
  const { data, error } = await supabase.from('applications').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data as ApplicationRow[];
}

/** One item of the list a student submits. */
export function toPayload(d: ApplicationDraft) {
  return {
    company_name: d.company_name.trim(),
    test_date: d.test_date || null,
    role: d.role.trim() || null,
    application_stage: d.application_stage,
    stage_is_default: d.stage_is_default,
    notes: d.notes.trim() || null,
  };
}

/**
 * "Submit Applications": saves the student's complete list in one database
 * transaction and returns what is now stored. Throws on any failure —
 * callers must not show success unless this resolves.
 */
export async function submitApplications(items: ApplicationDraft[]): Promise<ApplicationRow[]> {
  const { data, error } = await supabase.rpc('submit_applications', { p_items: items.map(toPayload) });
  if (error) throw error;
  return data as ApplicationRow[];
}

export interface StatsResult {
  rows: CompanyStat[];
  total: number;
  refreshedAt: Date;
}

/** Batch-wide aggregate only: company, distinct students, percentage. */
export async function fetchCompanyStats(): Promise<StatsResult> {
  const { data, error } = await supabase.rpc('company_application_stats');
  if (error) throw error;
  const rows = (data ?? []) as { company: string; students: number; percent: number | string; total_relationships: number; refreshed_at: string }[];
  return {
    rows: rows.map((r) => ({ company: r.company, students: r.students, percent: Number(r.percent) })),
    total: rows[0]?.total_relationships ?? 0,
    refreshedAt: rows[0] ? new Date(rows[0].refreshed_at) : new Date(),
  };
}
