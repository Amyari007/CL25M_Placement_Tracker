/**
 * coordinator-api: the ONLY route by which a placement coordinator gets data.
 *
 * Per request:
 *   1. The access token is verified by Supabase Auth (deps.verifyToken);
 *      user id, session id and MFA level come from that verified token.
 *   2. The database reports the account's state and its registered
 *      device's public key (svc_coordinator_status).
 *   3. Protected actions must carry a fresh signature from that device's
 *      non-extractable private key, bound to this session and payload,
 *      with a one-time nonce (svc_nonce_use).
 *   4. The svc_* function then re-checks everything in the database
 *      (role, suspension, live session, AAL2, device, company, rate) and
 *      writes the audit event.
 * Errors are generic; nothing is returned before every check passes.
 */
import { clientIp, corsHeaders, json, preflight, requestId, userAgent } from './http.ts';
import {
  MAX_CLOCK_SKEW_MS,
  canonical,
  envelopeShapeOk,
  isPublicJwk,
  jwkThumbprint,
  verifySignature,
  type PublicJwk,
  type SignedEnvelope,
} from './device.ts';
import { companyExportFilename, type CompanyApplicantRow } from './workbook.ts';

export interface Caller {
  uid: string;
  sid: string;
  aal: string;
  email: string | null;
}

export interface CoordinatorDeps {
  verifyToken(token: string): Promise<Caller | null>;
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): Promise<any>;
  setPassword(uid: string, password: string): Promise<void>;
  buildExport(company: string, rows: CompanyApplicantRow[], now: Date): Promise<Uint8Array>;
  now(): number;
}

const SIGNED_ACTIONS = new Set(['session.begin', 'dashboard', 'applicants', 'export', 'outreach.update']);
const UNAVAILABLE = 'This action is unavailable for your account. Please contact the administrator for assistance.';
const DEVICE_MSG = 'This browser is not the registered device for this account. Please contact the administrator for assistance.';

const REASON_MESSAGE: Record<string, string> = {
  rate: 'Too many requests. Please wait a few minutes and try again.',
  company: 'This company is not assigned to you.',
  invalid: 'Please check the values and try again.',
  approval_required: 'A new device needs approval from the administrator.',
  already_registered: 'A device is already registered for this account.',
  key_reused: 'This device could not be registered. Please contact the administrator.',
  bad_key: 'This browser could not create a device key. Please use an up-to-date browser.',
};

const COMMON = new Set([
  'password1234', 'password12345', 'password@123', 'qwertyuiop12', '123456789012', 'iloveyou1234', 'admin@123456',
  'welcome@1234', 'placement123', 'placement@123', 'iitmadras123', 'iitmadras@123', 'changeme1234',
]);

export function passwordProblem(pw: string, email: string | null): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common.';
  if (/^(.)\1+$/.test(pw)) return 'That password is too simple.';
  const local = (email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'Do not include your email name in the password.';
  return null;
}

type Body = { action?: unknown; payload?: unknown; auth?: unknown };

export async function handleCoordinator(req: Request, deps: CoordinatorDeps): Promise<Response> {
  const early = preflight(req);
  if (early) return early;
  const reqId = requestId();
  const ip = clientIp(req);
  const ua = userAgent(req);

  const authz = req.headers.get('Authorization') ?? '';
  const caller = authz.startsWith('Bearer ') ? await deps.verifyToken(authz.slice(7)).catch(() => null) : null;
  if (!caller) return json(req, { error: 'unauthorized', message: 'Please sign in again.' }, 401);

  let body: Body;
  try {
    const text = await req.text();
    if (text.length > 20_000) throw new Error('too large');
    body = JSON.parse(text);
  } catch {
    return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  }
  const action = typeof body.action === 'string' ? body.action : '';
  // The payload travels as text so the signature covers exactly these bytes.
  const payloadText = typeof body.payload === 'string' ? body.payload : 'null';
  if (payloadText.length > 10_000) return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  let payload: Record<string, unknown> = {};
  try {
    const p = JSON.parse(payloadText);
    if (p && typeof p === 'object' && !Array.isArray(p)) payload = p;
  } catch {
    return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  }

  const ctx = { uid: caller.uid, sid: caller.sid, aal: caller.aal, ip, ua, req: reqId } as Record<string, unknown>;
  const status = (await deps.rpc('svc_coordinator_status', { ctx })) as {
    state: string;
    email?: string;
    device?: { id: string; public_key: PublicJwk };
  };
  const state = status?.state ?? 'unavailable';
  if (state === 'unavailable') {
    await deps.rpc('svc_log_event', {
      p_actor: caller.uid, p_type: 'coord.request', p_outcome: 'denied', p_ip: ip, p_ua: ua, p_request: reqId,
      p_detail: { action: action.slice(0, 40), reason: 'unavailable' },
    });
    return json(req, { error: 'unavailable', state, message: UNAVAILABLE }, 403);
  }

  // Signature check (only possible once a device is registered).
  let deviceOk = false;
  let sigPresent = false;
  if (state === 'device_check' && status.device) {
    const env = body.auth;
    sigPresent = envelopeShapeOk(env);
    if (sigPresent) {
      const e = env as SignedEnvelope;
      const fresh = Math.abs(deps.now() - e.ts) <= MAX_CLOCK_SKEW_MS;
      const msg = await canonical(action, e.ts, e.nonce, caller.sid, payloadText);
      const valid = fresh && (await verifySignature(status.device.public_key, msg, e.sig));
      deviceOk = valid && (await deps.rpc('svc_nonce_use', { p_uid: caller.uid, p_nonce: e.nonce })) === true;
    }
  }

  // ---- status: where is this account in the access flow?
  if (action === 'status') {
    if (state === 'device_check') {
      if (!deviceOk) {
        await deps.rpc('svc_log_event', {
          p_actor: caller.uid, p_type: 'device.unrecognized', p_outcome: 'denied', p_ip: ip, p_ua: ua, p_request: reqId,
          p_detail: { signature: sigPresent ? 'invalid' : 'missing' },
        });
        return json(req, { state: 'device_unrecognized', email: status.email, message: DEVICE_MSG });
      }
      return json(req, { state: 'ready', email: status.email });
    }
    return json(req, { state, email: status.email });
  }

  // ---- 6-digit PIN: chosen at first sign-in, entered at every sign-in
  if (action === 'pin.set' || action === 'pin.verify') {
    const pin = typeof payload.pin === 'string' ? payload.pin : '';
    const r = await deps.rpc('svc_coord_pin', { ctx, p_action: action === 'pin.set' ? 'set' : 'verify', p_pin: pin });
    if (r?.ok) return json(req, { ok: true });
    if (r?.reason === 'weak_pin') return json(req, { error: 'weak_pin', message: 'Choose 6 digits that are not a simple pattern (not 123456, 111111 and similar).' }, 400);
    if (r?.reason === 'wrong_pin') return json(req, { error: 'wrong_pin', message: 'That PIN is not correct.' }, 400);
    if (r?.reason === 'rate') return json(req, { error: 'rate_limited', message: 'Too many wrong PINs. Please wait 15 minutes and try again.' }, 429, { 'Retry-After': '900' });
    if (r?.reason === 'pin_exists') return json(req, { error: 'pin_exists', message: 'A PIN is already set for this account.' }, 409);
    return json(req, { error: 'unavailable', message: UNAVAILABLE }, 403);
  }

  // ---- password rotation (before device registration)
  if (action === 'account.password') {
    if (state !== 'password_change') return json(req, { error: 'unavailable', state, message: UNAVAILABLE }, 403);
    const pw = typeof payload.password === 'string' ? payload.password : '';
    const problem = passwordProblem(pw, status.email ?? caller.email);
    if (problem) return json(req, { error: 'weak_password', message: problem }, 400);
    const check = await deps.rpc('svc_coord_check', { ctx, p_action: 'password' });
    if (!check?.ok) return denied(req, check?.reason);
    try {
      await deps.setPassword(caller.uid, pw);
    } catch {
      await deps.rpc('svc_log_event', {
        p_actor: caller.uid, p_type: 'account.password_change', p_outcome: 'error', p_ip: ip, p_ua: ua, p_request: reqId, p_detail: {},
      });
      return json(req, { error: 'server_error', message: 'The password could not be changed. Please try again.' }, 500);
    }
    await deps.rpc('svc_coord_password_changed', { ctx });
    return json(req, { ok: true });
  }

  // ---- device enrollment (proof of possession with the new key)
  if (action === 'device.enroll') {
    if (state !== 'device_enroll') {
      await deps.rpc('svc_log_event', {
        p_actor: caller.uid, p_type: 'device.enroll', p_outcome: 'denied', p_ip: ip, p_ua: ua, p_request: reqId,
        p_detail: { reason: state },
      });
      return json(req, { error: 'unavailable', state, message: state === 'device_check' ? REASON_MESSAGE.already_registered : UNAVAILABLE }, 403);
    }
    const jwk = payload.publicKey;
    const env = body.auth;
    if (!isPublicJwk(jwk) || !envelopeShapeOk(env)) return denied(req, 'bad_key');
    const e = env as SignedEnvelope;
    const msg = await canonical(action, e.ts, e.nonce, caller.sid, payloadText);
    const proof =
      Math.abs(deps.now() - e.ts) <= MAX_CLOCK_SKEW_MS &&
      (await verifySignature(jwk, msg, e.sig)) &&
      (await deps.rpc('svc_nonce_use', { p_uid: caller.uid, p_nonce: e.nonce })) === true;
    if (!proof) return denied(req, 'bad_key');
    const label = typeof payload.label === 'string' ? payload.label.slice(0, 80) : null;
    const r = await deps.rpc('svc_device_enroll', {
      ctx, p_public_key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, p_thumbprint: await jwkThumbprint(jwk), p_label: label,
    });
    if (!r?.ok) return denied(req, r?.reason);
    return json(req, { ok: true });
  }

  if (!SIGNED_ACTIONS.has(action)) return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);

  // ---- everything below requires the registered device
  if (state !== 'device_check' || !deviceOk) {
    await deps.rpc('svc_log_event', {
      p_actor: caller.uid,
      p_type: state === 'device_check' ? 'device.unrecognized' : 'coord.request',
      p_outcome: 'denied', p_ip: ip, p_ua: ua, p_request: reqId,
      p_detail: { action, reason: state === 'device_check' ? (sigPresent ? 'bad_signature' : 'no_signature') : state },
    });
    return json(req, { error: 'unavailable', state: state === 'device_check' ? 'device_unrecognized' : state,
                       message: state === 'device_check' ? DEVICE_MSG : UNAVAILABLE }, 403);
  }
  ctx.device_id = status.device!.id;

  if (action === 'session.begin') {
    const r = await deps.rpc('svc_coord_session_begin', { ctx });
    return r?.ok ? json(req, { ok: true }) : denied(req, r?.reason);
  }
  if (action === 'dashboard') {
    const r = await deps.rpc('svc_coord_dashboard', { ctx });
    return r?.ok ? json(req, r) : denied(req, r?.reason);
  }
  if (action === 'applicants' || action === 'export') {
    const company = typeof payload.company === 'string' ? payload.company.slice(0, 120) : '';
    const r = await deps.rpc('svc_coord_applicants', { ctx, p_company: company, p_purpose: action === 'export' ? 'export' : 'view' });
    if (!r?.ok) return denied(req, r?.reason);
    if (action === 'applicants') return json(req, r);
    const now = new Date(deps.now());
    let buf: Uint8Array;
    try {
      buf = await deps.buildExport(r.company, r.rows as CompanyApplicantRow[], now);
    } catch {
      await deps.rpc('svc_log_event', {
        p_actor: caller.uid, p_type: 'coord.export_build', p_outcome: 'error', p_ip: ip, p_ua: ua, p_request: reqId,
        p_detail: {}, p_company: r.company_key,
      });
      return json(req, { error: 'server_error', message: 'The export could not be created. Please try again.' }, 500);
    }
    return new Response(buf, {
      status: 200,
      headers: {
        ...corsHeaders(req),
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${companyExportFilename(r.company, now)}"`,
        'Cache-Control': 'no-store, private',
      },
    });
  }
  if (action === 'outreach.update') {
    const company = typeof payload.company === 'string' ? payload.company.slice(0, 120) : '';
    const fields = payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields) ? payload.fields : {};
    const allowedKeys = ['outreach_status', 'recruitment_stage', 'last_contact', 'next_action', 'next_action_date', 'assessment_date'];
    const clean = Object.fromEntries(
      Object.entries(fields as Record<string, unknown>)
        .filter(([k, v]) => allowedKeys.includes(k) && (v === null || typeof v === 'string'))
        .map(([k, v]) => [k, v === null ? '' : v]),
    );
    const r = await deps.rpc('svc_coord_outreach_update', { ctx, p_company: company, p_fields: clean });
    return r?.ok ? json(req, r) : denied(req, r?.reason);
  }
  return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
}

function denied(req: Request, reason: string | undefined): Response {
  const r = reason ?? 'unavailable';
  if (r === 'rate') return json(req, { error: 'rate_limited', message: REASON_MESSAGE.rate }, 429, { 'Retry-After': '600' });
  if (r === 'invalid' || r === 'bad_key') return json(req, { error: r, message: REASON_MESSAGE[r] }, 400);
  return json(req, { error: 'unavailable', reason: r in REASON_MESSAGE ? r : undefined, message: REASON_MESSAGE[r] ?? UNAVAILABLE }, 403);
}
