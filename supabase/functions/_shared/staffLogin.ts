/**
 * staff-login: email + password sign-in for the administrator and the
 * placement coordinators, with throttling, generic errors and audit events.
 * Returns Supabase session tokens only for accounts allowed into a portal.
 */
import { clientIp, json, preflight, requestId, userAgent } from './http.ts';

export interface StaffLoginDeps {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): Promise<any>;
  signIn(email: string, password: string): Promise<{ uid: string; access_token: string; refresh_token: string } | null>;
  signOut(accessToken: string): Promise<void>;
}

const GENERIC = { error: 'invalid_credentials', message: 'Incorrect email or password.' };

export async function handleStaffLogin(req: Request, deps: StaffLoginDeps): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  const ip = clientIp(req);
  const ua = userAgent(req);
  const reqId = requestId();

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  }
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200 || password.length < 1 || password.length > 200) {
    return json(req, GENERIC, 401);
  }

  const gate = await deps.rpc('svc_staff_login_gate', { p_email: email, p_ip: ip });
  if (!gate?.allowed) {
    await deps.rpc('svc_log_event', {
      p_actor: null, p_type: 'auth.login', p_outcome: 'denied', p_ip: ip, p_ua: ua, p_request: reqId, p_detail: { reason: 'throttled' },
    });
    return json(req, { error: 'throttled', message: 'Too many attempts. Please wait 15 minutes and try again.' }, 429, {
      'Retry-After': String(gate?.retry_after ?? 900),
    });
  }

  const session = await deps.signIn(email, password).catch(() => null);
  const result = await deps.rpc('svc_staff_login_result', {
    p_email: email, p_uid: session?.uid ?? null, p_success: !!session, p_ip: ip, p_ua: ua, p_request: reqId,
  });
  if (!session) return json(req, GENERIC, 401);
  if (result?.role !== 'admin' && result?.role !== 'coordinator') {
    await deps.signOut(session.access_token).catch(() => undefined);
    return json(req, { error: 'no_access', message: 'This account does not have access. Please contact the administrator for assistance.' }, 403);
  }
  return json(req, { access_token: session.access_token, refresh_token: session.refresh_token, role: result.role });
}
