import { useCallback, useEffect, useState } from 'react';
import ExcelJS from 'exceljs';
import { ApiError } from '../errors';
import type { ApplicationRow, StudentRow } from '../types';
import { buildWorkbook, exportFilename } from '../../../supabase/functions/_shared/workbook.ts';
import { getSession, hashSecret, load, publicStudent, randomSalt, save, subscribe } from './store';

function requireAdmin() {
  if (getSession()?.kind !== 'admin') throw new ApiError('Administrator access required.', 403);
  return load();
}
function requireStaff() {
  const k = getSession()?.kind;
  if (k !== 'admin' && k !== 'team') throw new ApiError('Placement-team access required.', 403);
  return load();
}

export interface BatchData {
  students: StudentRow[];
  applications: ApplicationRow[];
  fetchedAt: Date;
  namesHidden: boolean;
}

function read(): BatchData {
  const store = requireStaff();
  const hide = getSession()?.kind !== 'admin';
  return {
    students: store.students.map((s) => ({ ...publicStudent(s), name: hide ? null : s.name })),
    applications: store.applications,
    fetchedAt: new Date(),
    namesHidden: hide,
  };
}

export function useBatchData() {
  const [data, setData] = useState<BatchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setData(read());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);
  return { data, error, refreshing: false, refresh };
}

export async function downloadExport(): Promise<string> {
  requireAdmin();
  const { students, applications } = read();
  const now = new Date();
  const wb = buildWorkbook(ExcelJS, { students, applications, now });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const name = exportFilename(now);
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
  return requireAdmin().students.map((s) => ({
    student_id: s.id,
    roll_number: s.roll_number,
    has_code: true,
    is_prototype: s.is_prototype,
    rotated_at: s.rotated_at,
    linked: s.linked,
  }));
}

function randomCode(): string {
  const limit = Math.floor(0xffffffff / 1e6) * 1e6;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 1e6).padStart(6, '0');
}

function rotateIn(store: ReturnType<typeof load>, studentId: string) {
  const s = store.students.find((x) => x.id === studentId);
  if (!s) throw new ApiError('Unknown student.', 400);
  const code = randomCode();
  s.code_salt = randomSalt();
  s.code_hash = hashSecret(s.code_salt, code);
  s.is_prototype = false;
  s.rotated_at = new Date().toISOString();
  s.session_epoch++;
  delete store.failures[s.roll_number];
  return { rollNumber: s.roll_number, code };
}

export async function rotateCode(studentId: string) {
  const store = requireAdmin();
  const r = rotateIn(store, studentId);
  save(store);
  return r;
}

export async function rotateAll() {
  const store = requireAdmin();
  const codes = store.students.map((s) => rotateIn(store, s.id));
  save(store);
  return { codes };
}

export async function revokeSessions(studentId: string) {
  const store = requireAdmin();
  const s = store.students.find((x) => x.id === studentId);
  if (s) s.session_epoch++;
  save(store);
}

/* ---------------------------------------------------------- placement team */
export interface TeamMember {
  user_id: string;
  email: string;
  granted_at: string;
  revoked_at: string | null;
}

function adminOnly() {
  if (getSession()?.kind !== 'admin') throw new ApiError('Administrator access required.', 403);
  return load();
}

export async function listTeam(): Promise<TeamMember[]> {
  return (adminOnly().team ?? []).map((t) => ({ user_id: t.email, email: t.email, granted_at: t.granted_at, revoked_at: t.revoked_at }));
}

export async function addTeamMember(email: string): Promise<{ email: string; tempPassword?: string }> {
  const store = adminOnly();
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ApiError('Enter a valid email address.', 400);
  if (store.admin?.email === e) throw new ApiError('That account is already the administrator', 400);
  store.team ??= [];
  const existing = store.team.find((t) => t.email === e);
  if (existing) {
    existing.revoked_at = null;
    existing.granted_at = new Date().toISOString();
    save(store);
    return { email: e };
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const tempPassword = [...crypto.getRandomValues(new Uint8Array(14))].map((b) => alphabet[b % alphabet.length]).join('');
  const salt = randomSalt();
  store.team.push({ email: e, salt, hash: hashSecret(salt, tempPassword), granted_at: new Date().toISOString(), revoked_at: null });
  save(store);
  return { email: e, tempPassword };
}

export async function revokeTeamMember(userId: string): Promise<void> {
  const store = adminOnly();
  const t = (store.team ?? []).find((m) => m.email === userId);
  if (t) t.revoked_at = new Date().toISOString();
  save(store);
}

export async function reapproveTeamMember(email: string): Promise<void> {
  await addTeamMember(email);
}
