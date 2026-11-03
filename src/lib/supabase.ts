import { createClient } from '@supabase/supabase-js';
import { ApiError } from './errors';
export { ApiError, friendlyError } from './errors';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const isConfigured = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

// Only the public URL and anon/publishable key are ever shipped to browsers.
export const supabase = createClient(SUPABASE_URL ?? 'http://localhost', SUPABASE_ANON_KEY ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'cl25m-auth' },
});

/** Calls an edge function with the caller's session token. */
export async function callFunction(name: string, body: unknown, opts: { auth?: boolean } = { auth: true }): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY ?? '' };
  if (opts.auth !== false) {
    const { data } = await supabase.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'network');
  }
  if (!res.ok) {
    let msg = 'Something went wrong. Please try again.';
    let code: string | undefined;
    try {
      const j = await res.json();
      msg = j.message ?? msg;
      code = j.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status, code);
  }
  return res;
}

