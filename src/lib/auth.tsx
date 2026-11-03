import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ApiError, callFunction, supabase } from './supabase';
import type { StudentRow } from './types';

export type Role = 'student' | 'admin' | 'team' | 'none';

interface AuthCtx {
  loading: boolean;
  session: Session | null;
  role: Role;
  student: StudentRow | null;
  /** Admin has MFA enrolled but this session is not yet verified (AAL1). */
  mfaPending: boolean;
  /** Offline build only: no administrator password has been created yet. */
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>('none');
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);

  const load = useCallback(async (s: Session | null) => {
    const seq = ++loadSeq.current;
    setSession(s);
    if (!s) {
      setRole('none');
      setStudent(null);
      setMfaPending(false);
      setLoading(false);
      return;
    }
    try {
      // These reads are UI routing hints only; the database enforces access.
      const [stu, adm, tm] = await Promise.all([
        supabase
          .from('students')
          .select('id, roll_number, profile_completed_at, last_activity_at, submitted_at')
          .eq('user_id', s.user.id)
          .maybeSingle(),
        supabase.from('admins').select('user_id').eq('user_id', s.user.id).maybeSingle(),
        supabase.from('team_members').select('user_id').eq('user_id', s.user.id).is('revoked_at', null).is('suspended_at', null).maybeSingle(),
      ]);
      if (seq !== loadSeq.current) return;
      if (stu.data) {
        // Names are not readable from the table; a student reads their own via my_profile().
        const { data: prof } = await supabase.rpc('my_profile');
        if (seq !== loadSeq.current) return;
        const name = (prof as { name: string | null }[] | null)?.[0]?.name ?? null;
        setRole('student');
        setStudent({ ...(stu.data as Omit<StudentRow, 'name'>), name });
        setMfaPending(false);
      } else if (adm.data || tm.data) {
        setRole(adm.data ? 'admin' : 'team');
        setStudent(null);
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        setMfaPending(aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2');
      } else {
        setRole('none');
        setStudent(null);
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'TOKEN_REFRESHED') {
        setSession(s);
        return;
      }
      // Defer: calling supabase inside this callback can deadlock the client.
      setTimeout(() => load(s), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const value = useMemo<AuthCtx>(
    () => ({
      loading,
      session,
      role,
      student,
      mfaPending,
      adminSetupRequired: false,
      async setupAdmin() {
        throw new ApiError('Create the administrator in Supabase (see README).', 400);
      },
      async studentSignIn(roll, code) {
        const res = await callFunction('student-login', { rollNumber: roll, accessCode: code }, { auth: false });
        const tokens = (await res.json()) as { access_token: string; refresh_token: string };
        setLoading(true);
        const { error } = await supabase.auth.setSession(tokens);
        if (error) throw new ApiError('Sign-in failed. Please try again.', 500);
      },
      async adminSignIn(email, password) {
        // Server-side sign-in: throttled, audited, and only for the administrator
        // or an active coordinator (errors stay generic).
        const res = await callFunction('staff-login', { email, password }, { auth: false });
        const tokens = (await res.json()) as { access_token: string; refresh_token: string };
        setLoading(true);
        const { error } = await supabase.auth.setSession(tokens);
        if (error) throw new ApiError('Sign-in failed. Please try again.', 500);
      },
      async completeMfa(code) {
        const { data: factors, error } = await supabase.auth.mfa.listFactors();
        if (error) throw error;
        const totp = factors.totp.find((f) => f.status === 'verified');
        if (!totp) throw new ApiError('No authenticator is set up for this account.', 400);
        const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
        if (vErr) throw new ApiError('That code is not valid. Check your authenticator app and try again.', 401);
        const { data } = await supabase.auth.getSession();
        await load(data.session);
      },
      async refresh() {
        const { data } = await supabase.auth.getSession();
        await load(data.session);
      },
      setStudent,
      async signOut() {
        // 'global' revokes refresh tokens on every device for this user.
        await supabase.auth.signOut({ scope: 'global' }).catch(() => supabase.auth.signOut({ scope: 'local' }));
        await load(null);
      },
    }),
    [loading, session, role, student, mfaPending, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
