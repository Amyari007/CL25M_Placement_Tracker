import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../errors';
import type { StudentRow } from '../types';
import { getSession, hashSecret, load, publicStudent, randomSalt, save, setSession, subscribe } from './store';

export type Role = 'student' | 'admin' | 'team' | 'none';

interface AuthCtx {
  loading: boolean;
  session: { user: { email?: string } } | null;
  role: Role;
  student: StudentRow | null;
  mfaPending: boolean;
  adminSetupRequired: boolean;
  setupAdmin(email: string, password: string): Promise<void>;
  studentSignIn(roll: string, code: string): Promise<void>;
  adminSignIn(email: string, password: string): Promise<void>;
  completeMfa(code: string): Promise<void>;
  refresh(): Promise<void>;
  setStudent(s: StudentRow): void;
  signOut(): Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => subscribe(bump), [bump]);

  const state = useMemo(() => {
    const store = load();
    const sess = getSession();
    let role: Role = 'none';
    let student: StudentRow | null = null;
    if (sess?.kind === 'student') {
      const s = store.students.find((x) => x.id === sess.studentId);
      if (s) {
        role = 'student';
        student = publicStudent(s);
      }
    } else if (sess?.kind === 'admin') role = 'admin';
    else if (sess?.kind === 'team') role = 'team';
    return { role, student, adminSetupRequired: !store.admin, adminEmail: sess?.kind === 'team' ? sess.email : store.admin?.email };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const value = useMemo<AuthCtx>(
    () => ({
      loading: false,
      session: state.role === 'none' ? null : { user: { email: state.role === 'admin' || state.role === 'team' ? state.adminEmail : undefined } },
      role: state.role,
      student: state.student,
      mfaPending: false,
      adminSetupRequired: state.adminSetupRequired,
      async setupAdmin(email, password) {
        const store = load();
        if (store.admin) throw new ApiError('An administrator already exists.', 400);
        const salt = randomSalt();
        store.admin = { email: email.trim().toLowerCase(), salt, hash: hashSecret(salt, password) };
        save(store);
        setSession({ kind: 'admin' });
        bump();
      },
      async studentSignIn(roll, code) {
        await wait(350);
        const store = load();
        const r = roll.trim().toUpperCase();
        const now = Date.now();
        const fails = (store.failures[r] ?? []).filter((t) => now - t < LOCK_MS);
        if (fails.length >= MAX_FAILS) {
          const mins = Math.ceil((LOCK_MS - (now - fails[0])) / 60000);
          throw new ApiError(`Too many attempts. Try again in about ${mins} minute(s).`, 429, 'throttled');
        }
        const s = store.students.find((x) => x.roll_number === r);
        if (!s || hashSecret(s.code_salt, code.trim()) !== s.code_hash) {
          store.failures[r] = [...fails, now];
          save(store);
          throw new ApiError('That roll number and access code do not match.', 401);
        }
        delete store.failures[r];
        s.linked = true;
        save(store);
        setSession({ kind: 'student', studentId: s.id, epoch: s.session_epoch });
        bump();
      },
      async adminSignIn(email, password) {
        await wait(350);
        const store = load();
        const e = email.trim().toLowerCase();
        const a = store.admin;
        if (a && a.email === e && hashSecret(a.salt, password) === a.hash) {
          setSession({ kind: 'admin' });
          bump();
          return;
        }
        const t = (store.team ?? []).find((m) => m.email === e);
        if (!t || hashSecret(t.salt, password) !== t.hash) throw new ApiError('Incorrect email or password.', 401);
        if (t.revoked_at) throw new ApiError('This account no longer has placement-team access.', 403);
        setSession({ kind: 'team', email: e });
        bump();
      },
      async completeMfa() {},
      async refresh() {
        bump();
      },
      setStudent() {
        bump();
      },
      async signOut() {
        setSession(null);
        bump();
      },
    }),
    [state, bump],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
