/**
 * admin-team (administrator only): coordinator accounts that need the Auth
 * admin API.
 *   { action: 'provision', email }       → { email, tempPassword }
 *   { action: 'reset_password', userId } → { email, tempPassword }
 * A temporary password is shown ONCE to the administrator; the coordinator
 * must set their own password (after MFA) before any data is available.
 * Existing accounts are reused, never duplicated; their old password is
 * treated as exposed and replaced.
 */
import { clientIp, json, preflight, requestId, userAgent } from './http.ts';

export interface AdminSecurityDeps {
  requireAdmin(req: Request): Promise<{ uid: string } | null>;
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): Promise<any>;
  findUserId(email: string): Promise<string | null>;
  createUser(email: string, password: string): Promise<string>;
  setPassword(uid: string, password: string): Promise<void>;
}

export function tempPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length);
  const out: string[] = [];
  while (out.length < 18) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < 18) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join('');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleAdminSecurity(req: Request, deps: AdminSecurityDeps): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  const ip = clientIp(req);
  const ua = userAgent(req);
  const reqId = requestId();
  const admin = await deps.requireAdmin(req).catch(() => null);
  if (!admin) return json(req, { error: 'forbidden', message: 'This action is unavailable for your account.' }, 403);

  let body: { action?: unknown; email?: unknown; userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  }

  try {
    if (body.action === 'provision') {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
        return json(req, { error: 'bad_request', message: 'Enter a valid email address.' }, 400);
      }
      const pw = tempPassword();
      let uid = await deps.findUserId(email);
      if (uid) {
        const r0 = await deps.rpc('svc_coordinator_provision', { p_admin: admin.uid, p_uid: uid, p_email: email, p_ip: ip, p_ua: ua, p_request: reqId });
        if (!r0?.ok) return refuse(req, r0?.reason);
        await deps.setPassword(uid, pw); // previous password treated as exposed
      } else {
        uid = await deps.createUser(email, pw);
        const r1 = await deps.rpc('svc_coordinator_provision', { p_admin: admin.uid, p_uid: uid, p_email: email, p_ip: ip, p_ua: ua, p_request: reqId });
        if (!r1?.ok) return refuse(req, r1?.reason);
      }
      return json(req, { email, tempPassword: pw });
    }

    if (body.action === 'reset_password') {
      const userId = String(body.userId ?? '');
      if (!UUID.test(userId)) return json(req, { error: 'bad_request', message: 'Unknown coordinator.' }, 400);
      const who = await deps.rpc('svc_coordinator_by_id', { p_uid: userId });
      if (!who?.user_id) return json(req, { error: 'bad_request', message: 'Unknown coordinator.' }, 400);
      const pw = tempPassword();
      await deps.setPassword(userId, pw);
      const r = await deps.rpc('svc_coordinator_credential_reset', { p_admin: admin.uid, p_uid: userId, p_ip: ip, p_ua: ua, p_request: reqId });
      if (!r?.ok) return refuse(req, r?.reason);
      return json(req, { email: who.email, tempPassword: pw });
    }
    return json(req, { error: 'bad_request', message: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('admin-team failed', e instanceof Error ? e.message : 'error');
    await deps.rpc('svc_log_event', {
      p_actor: admin.uid, p_type: 'admin.coordinator_change', p_outcome: 'error', p_ip: ip, p_ua: ua, p_request: reqId, p_detail: {},
    }).catch(() => undefined);
    return json(req, { error: 'server_error', message: 'The change could not be saved.' }, 500);
  }
}

function refuse(req: Request, reason: string | undefined): Response {
  const msg =
    reason === 'student_account' ? 'Student sign-ins cannot be coordinators.'
    : reason === 'admin_account' ? 'That account is the administrator.'
    : 'The change could not be saved.';
  return json(req, { error: 'rejected', message: msg }, 400);
}
