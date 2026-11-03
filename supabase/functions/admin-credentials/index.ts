/**
 * POST (admin only)
 *   { action: 'rotate', studentId, code? }   → { code }   new code shown once
 *   { action: 'rotate_all' }                 → { codes: [{ rollNumber, code }] }
 *   { action: 'revoke_sessions', studentId } → { ok: true }
 * Rotation also signs the student out of every device.
 */
import { clientIp, json, preflight, requestId, userAgent } from '../_shared/http.ts';
import { requireAdminUser, serviceClient } from '../_shared/auth.ts';

function randomCode(digits = 6): string {
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max; // avoid modulo bias
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % max).padStart(digits, '0');
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  const who = await requireAdminUser(req);
  if (!who) return json(req, { error: 'forbidden', message: 'This action is unavailable for your account.' }, 403);
  const reqId = requestId();

  let body: { action?: string; studentId?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'bad_request', message: 'Invalid request.' }, 400);
  }

  const svc = serviceClient();
  const log = (type: string, detail: Record<string, unknown>) =>
    svc.rpc('svc_log_event', { p_actor: who.uid, p_type: type, p_outcome: 'success', p_ip: clientIp(req), p_ua: userAgent(req), p_request: reqId, p_detail: detail });
  const uuid = /^[0-9a-f-]{36}$/i;

  async function rotate(studentId: string, code: string) {
    const { error } = await svc.rpc('set_student_code', { p_student_id: studentId, p_code: code, p_is_prototype: false });
    if (error) throw error;
    const { data: s } = await svc.from('students').select('roll_number, user_id').eq('id', studentId).single();
    if (s?.user_id) await svc.rpc('revoke_user_sessions', { p_user_id: s.user_id });
    return s?.roll_number as string;
  }

  try {
    if (body.action === 'rotate') {
      if (!body.studentId || !uuid.test(body.studentId)) return json(req, { error: 'bad_request', message: 'Unknown student.' }, 400);
      if (body.code && !/^\d{6,12}$/.test(body.code))
        return json(req, { error: 'bad_request', message: 'Custom codes must be 6–12 digits.' }, 400);
      const code = body.code || randomCode();
      const rollNumber = await rotate(body.studentId, code);
      await log('admin.student_code_reset', { roll_number: rollNumber });
      return json(req, { rollNumber, code });
    }
    if (body.action === 'rotate_all') {
      const { data: students, error } = await svc.from('students').select('id, roll_number').order('roll_number');
      if (error) throw error;
      const codes: { rollNumber: string; code: string }[] = [];
      for (const s of students ?? []) {
        const code = randomCode();
        await rotate(s.id, code);
        codes.push({ rollNumber: s.roll_number, code });
      }
      await log('admin.student_codes_reset_all', { count: codes.length });
      return json(req, { codes });
    }
    if (body.action === 'revoke_sessions') {
      if (!body.studentId || !uuid.test(body.studentId)) return json(req, { error: 'bad_request', message: 'Unknown student.' }, 400);
      const { data: s } = await svc.from('students').select('user_id').eq('id', body.studentId).single();
      if (s?.user_id) await svc.rpc('revoke_user_sessions', { p_user_id: s.user_id });
      await log('admin.student_sessions_revoked', { student_id: body.studentId });
      return json(req, { ok: true });
    }
    return json(req, { error: 'bad_request', message: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('admin-credentials failed', e instanceof Error ? e.message : e);
    return json(req, { error: 'server_error', message: 'The change could not be saved.' }, 500);
  }
});
