import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { env } from './http.ts';

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** First non-empty key: legacy name, new single-key name, or new JSON key map. */
function key(...names: string[]): string {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (!v) continue;
    if (v.trim().startsWith('{')) {
      try {
        const first = Object.values(JSON.parse(v) as Record<string, string>).find(Boolean);
        if (first) return first;
      } catch {
        /* not JSON */
      }
      continue;
    }
    return v;
  }
  throw new Error(`Missing env ${names.join(' / ')}`);
}
export const serviceKey = () => key('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_SECRET_KEYS');
export const publicKey = () => key('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEYS');

/** Service-role client. Server only — never sent to browsers. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), serviceKey(), noPersist);
}

/** Client acting as the caller (RLS applies). */
export function callerClient(req: Request): SupabaseClient {
  return createClient(env('SUPABASE_URL'), publicKey(), {
    ...noPersist,
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

/**
 * Re-checks administrator rights on every request using the caller's own
 * token: the database's is_admin() (which also enforces MFA/AAL2).
 */
export async function requireAdmin(req: Request): Promise<SupabaseClient | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const caller = callerClient(req);
  const { data: user, error: userErr } = await caller.auth.getUser(auth.slice(7));
  if (userErr || !user?.user) return null;
  const { data, error } = await caller.rpc('is_admin');
  if (error || data !== true) return null;
  return caller;
}

/** Administrator check that also returns the verified user id. */
export async function requireAdminUser(req: Request): Promise<{ uid: string; caller: SupabaseClient } | null> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const caller = callerClient(req);
  const { data: user, error: userErr } = await caller.auth.getUser(auth.slice(7));
  if (userErr || !user?.user) return null;
  const { data, error } = await caller.rpc('is_admin');
  if (error || data !== true) return null;
  return { uid: user.user.id, caller };
}
