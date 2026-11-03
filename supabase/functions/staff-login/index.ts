/**
 * POST { email, password } → { access_token, refresh_token, role }
 * Administrator and placement-coordinator sign-in with throttling and audit.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { env } from '../_shared/http.ts';
import { publicKey, serviceClient } from '../_shared/auth.ts';
import { handleStaffLogin } from '../_shared/staffLogin.ts';

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

Deno.serve(async (req) => {
  const svc = serviceClient();
  try {
    return await handleStaffLogin(req, {
      async rpc(fn, args) {
        const { data, error } = await svc.rpc(fn, args);
        if (error) throw new Error(`${fn}: ${error.code ?? 'error'}`);
        return data;
      },
      async signIn(email, password) {
        const anon = createClient(env('SUPABASE_URL'), publicKey(), noPersist);
        const { data, error } = await anon.auth.signInWithPassword({ email, password });
        if (error || !data.session || !data.user) return null;
        return { uid: data.user.id, access_token: data.session.access_token, refresh_token: data.session.refresh_token };
      },
      async signOut(token) {
        await svc.auth.admin.signOut(token, 'local');
      },
    });
  } catch (e) {
    console.error('staff-login failed', e instanceof Error ? e.message : 'error');
    return new Response(JSON.stringify({ error: 'server_error', message: 'Sign-in is unavailable. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  }
});
