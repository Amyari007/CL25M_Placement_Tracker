/**
 * Offline data store for the single-file build.
 * Everything lives in this browser's localStorage (falls back to memory
 * where storage is blocked, e.g. some in-app previews).
 */
import { normalizeCompany, type ApplicationRow, type StudentRow } from '../../../supabase/functions/_shared/analytics.ts';
import { sha256Hex } from './sha256';

const KEY = 'cl25m-tracker-offline-v1';
const SESSION_KEY = 'cl25m-tracker-offline-session';

export interface LocalStudent extends StudentRow {
  code_hash: string;
  code_salt: string;
  is_prototype: boolean;
  rotated_at: string;
  linked: boolean;
  session_epoch: number;
}
export interface LocalStore {
  v: 1;
  students: LocalStudent[];
  applications: ApplicationRow[];
  admin: { email: string; hash: string; salt: string } | null;
  team?: LocalTeamMember[];
  failures: Record<string, number[]>; // roll → failure timestamps (ms)
}
export type LocalSession = { kind: 'student'; studentId: string; epoch: number } | { kind: 'admin' } | { kind: 'team'; email: string };
export interface LocalTeamMember {
  email: string;
  hash: string;
  salt: string;
  granted_at: string;
  revoked_at: string | null;
}

const ROLLS = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '015', '016'];
// Made-up demo codes for the offline version (stored hashed below, never in plain text).
const PROTOTYPE: Record<string, string> = {
  CL25M001: '3732', CL25M002: '4176', CL25M003: '4328', CL25M004: '4335', CL25M005: '4590',
  CL25M006: '8077', CL25M007: '8041', CL25M008: '9684', CL25M009: '4094', CL25M010: '3447',
  CL25M011: '7331', CL25M012: '5080', CL25M013: '7339', CL25M015: '9059', CL25M016: '8577',
};

let memory: string | null = null;
let memorySession: string | null = null;

function readRaw(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return k === KEY ? memory : memorySession;
  }
}
function writeRaw(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    if (k === KEY) memory = v;
    else memorySession = v;
  }
}

export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
}
export function randomSalt(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const hashSecret = (salt: string, secret: string) => sha256Hex(`${salt}:${secret}`);

function seed(): LocalStore {
  const now = new Date().toISOString();
  return {
    v: 1,
    students: ROLLS.map((r) => {
      const roll = `CL25M${r}`;
      const salt = randomSalt();
      return {
        id: randomId(),
        roll_number: roll,
        name: null,
        profile_completed_at: null,
        last_activity_at: now,
        code_hash: hashSecret(salt, PROTOTYPE[roll]),
        code_salt: salt,
        is_prototype: true,
        rotated_at: now,
        linked: false,
        session_epoch: 0,
      };
    }),
    applications: [],
    admin: null,
    failures: {},
  };
}

export function load(): LocalStore {
  const raw = readRaw(KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as LocalStore;
      if (s.v === 1 && Array.isArray(s.students) && s.students.length === 15) return s;
    } catch {
      /* fall through to a fresh store */
    }
  }
  const s = seed();
  save(s);
  return s;
}

const listeners = new Set<() => void>();
export function save(s: LocalStore) {
  writeRaw(KEY, JSON.stringify(s));
  listeners.forEach((l) => l());
}
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function getSession(): LocalSession | null {
  const raw = readRaw(SESSION_KEY);
  if (!raw) return null;
  try {
    const sess = JSON.parse(raw) as LocalSession;
    if (sess.kind === 'student') {
      const st = load().students.find((x) => x.id === sess.studentId);
      if (!st || st.session_epoch !== sess.epoch) return null; // revoked or code rotated
    }
    if (sess.kind === 'admin' && !load().admin) return null;
    if (sess.kind === 'team' && !(load().team ?? []).some((t) => t.email === sess.email && !t.revoked_at)) return null; // revoked
    return sess;
  } catch {
    return null;
  }
}
export function setSession(s: LocalSession | null) {
  writeRaw(SESSION_KEY, s ? JSON.stringify(s) : null);
}

/** Public view of a student (no secrets). */
export function publicStudent(s: LocalStudent): StudentRow {
  return {
    id: s.id,
    roll_number: s.roll_number,
    name: s.name,
    profile_completed_at: s.profile_completed_at,
    last_activity_at: s.last_activity_at,
    submitted_at: s.submitted_at ?? null,
  };
}

export function cleanText(t: string | null | undefined): string | null {
  const v = (t ?? '').trim().replace(/\s+/g, ' ');
  return v ? v : null;
}
export { normalizeCompany };
