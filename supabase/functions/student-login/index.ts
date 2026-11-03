/**
 * POST { rollNumber, accessCode } → { access_token, refresh_token }
 *
 * 1. Verifies the code against a bcrypt hash in the private schema, with
 *    per-roll and per-IP throttling (attempt_student_login).
 * 2. Ensures the student has a Supabase Auth user (created on first login).
 * 3. Mints a normal Supabase session for that user (magic-link token,
 *    generated and verified server-side — nothing is emailed).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { clientIp, env, json, preflight } from '../_shared/http.ts';
import { publicKey, serviceClient } from '../_shared/auth.ts';

const GENERIC = { error: 'invalid_credentials', message: 'That roll number and access code do not match.' };
const EMAIL_DOMAIN = Deno.env.get('STUDENT_EMAIL_DOMAIN') ?? 'students.cl25m-tracker.invalid';

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  let body: { rollNumber?: unknown; accessCode?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  }
  const roll = String(body.rollNumber ?? '').trim().toUpperCase();
  const code = String(body.accessCode ?? '').trim();
  if (!/^CL25M\d{3}$/.test(roll) || !/^\d{4,12}$/.test(code)) return json(req, GENERIC, 401);

  try {
    const admin = serviceClient();
    const { data, error } = await admin.rpc('attempt_student_login', { p_roll: roll, p_code: code, p_ip: clientIp(req) });
    if (error) throw error;
    const row = (data as Array<{ status: string; student_id: string | null; user_id: string | null; retry_after_seconds: number | null }>)[0];

    if (row?.status === 'throttled') {
      const wait = row.retry_after_seconds ?? 900;
      return json(
        req,
        { error: 'throttled', message: `Too many attempts. Try again in about ${Math.ceil(wait / 60)} minute(s).`, retryAfter: wait },
        429,
        { 'Retry-After': String(wait) },
      );
    }
    if (row?.status !== 'ok' || !row.student_id) return json(req, GENERIC, 401);

    const email = `${roll.toLowerCase()}@${EMAIL_DOMAIN}`;
    if (!row.user_id) {
      const pw = crypto.getRandomValues(new Uint8Array(32));
      const { error: createErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        password: btoa(String.fromCharCode(...pw)), // random, never used
        app_metadata: { role: 'student', roll_number: roll },
      });
      if (createErr && !/already|registered|exists/i.test(createErr.message)) throw createErr;
    }

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (linkErr || !link?.properties?.hashed_token || !link.user) throw linkErr ?? new Error('link failed');

    if (row.user_id !== link.user.id) {
      const { error: lErr } = await admin.rpc('link_student_user', { p_student_id: row.student_id, p_user_id: link.user.id });
      if (lErr) throw lErr;
    }

    const anon = createClient(env('SUPABASE_URL'), publicKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: verified, error: vErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
    if (vErr || !verified.session) throw vErr ?? new Error('session failed');

    return json(req, {
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
    });
  } catch (e) {
    console.error('student-login failed', e instanceof Error ? e.message : e);
    return json(req, { error: 'server_error', message: 'Sign-in is unavailable right now. Please try again.' }, 500);
  }
});
