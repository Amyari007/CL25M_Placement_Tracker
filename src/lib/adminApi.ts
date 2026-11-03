import { useCallback, useEffect, useRef, useState } from 'react';
import { callFunction, friendlyError, supabase } from './supabase';
import type { ApplicationRow, StudentRow } from './types';

const PAGE = 1000;

export interface BatchData {
  students: StudentRow[];
  applications: ApplicationRow[];
  fetchedAt: Date;
  /** True for placement-team members: the database withholds student names. */
  namesHidden: boolean;
}

async function fetchBatch(): Promise<BatchData> {
  // Row-level security returns all rows only to the administrator and approved team.
  // The name column is not readable from the browser at all; the administrator
  // gets names from admin_student_names(), team members get none.
  const { data: rows, error } = await supabase
    .from('students')
    .select('id, roll_number, profile_completed_at, last_activity_at, submitted_at')
    .order('roll_number');
  if (error) throw error;
  const { data: names, error: nErr } = await supabase.rpc('admin_student_names');
  const nameById = new Map(((nErr ? [] : names) as { student_id: string; name: string | null }[]).map((n) => [n.student_id, n.name]));
  const students = (rows as Omit<StudentRow, 'name'>[]).map((s) => ({ ...s, name: nameById.get(s.id) ?? null }));
  const applications: ApplicationRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error: e } = await supabase.from('applications').select('*').order('created_at').range(from, from + PAGE - 1);
    if (e) throw e;
    applications.push(...(data as ApplicationRow[]));
    if (data.length < PAGE) break;
  }
  return { students, applications, fetchedAt: new Date(), namesHidden: !!nErr };
}

/** Batch data that refreshes on realtime changes, focus, and every 60 s. */
export function useBatchData() {
  const [data, setData] = useState<BatchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await fetchBatch());
      setError(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const debounced = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 600);
    };
    const channel = supabase
      .channel('admin-batch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, debounced)
      .subscribe();
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    const iv = setInterval(() => document.visibilityState === 'visible' && refresh(), 60_000);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(iv);
      clearTimeout(timer.current);
    };
  }, [refresh]);

  return { data, error, refreshing, refresh };
}

export async function downloadExport(): Promise<string> {
  const res = await callFunction('admin-export', {});
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'CL25M-placement-export.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

export interface CredentialStatus {
  student_id: string;
  roll_number: string;
  has_code: boolean;
  is_prototype: boolean;
  rotated_at: string | null;
  linked: boolean;
}

export async function credentialStatus(): Promise<CredentialStatus[]> {
  const { data, error } = await supabase.rpc('admin_credential_status');
  if (error) throw error;
  return data as CredentialStatus[];
}

export async function rotateCode(studentId: string): Promise<{ rollNumber: string; code: string }> {
  const res = await callFunction('admin-credentials', { action: 'rotate', studentId });
  return res.json();
}

export async function rotateAll(): Promise<{ codes: { rollNumber: string; code: string }[] }> {
  const res = await callFunction('admin-credentials', { action: 'rotate_all' });
  return res.json();
}

export async function revokeSessions(studentId: string): Promise<void> {
  await callFunction('admin-credentials', { action: 'revoke_sessions', studentId });
}

/* ---------------------------------------------------------- placement team */
export interface TeamMember {
  user_id: string;
  email: string;
  granted_at: string;
  revoked_at: string | null;
}

export async function listTeam(): Promise<TeamMember[]> {
  const { data, error } = await supabase.rpc('admin_list_team');
  if (error) throw error;
  return data as TeamMember[];
}

/** Creates the login if needed (temporary password returned once) and approves it. */
export async function addTeamMember(email: string): Promise<{ email: string; tempPassword?: string }> {
  const res = await callFunction('admin-team', { action: 'add', email });
  return res.json();
}

export async function revokeTeamMember(userId: string): Promise<void> {
  const { error } = await supabase.rpc('admin_revoke_team', { p_user_id: userId });
  if (error) throw error;
}

export async function reapproveTeamMember(email: string): Promise<void> {
  const { error } = await supabase.rpc('admin_grant_team', { p_email: email });
  if (error) throw error;
}
