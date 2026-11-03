/**
 * POST (admin only) → .xlsx built from the current database records.
 * Authorization is re-checked on every request; data is read with the
 * admin's own token, so row-level security is the final gate.
 */
import ExcelJS from 'npm:exceljs@4.4.0';
import { clientIp, corsHeaders, json, preflight, requestId, userAgent } from '../_shared/http.ts';
import { requireAdminUser, serviceClient } from '../_shared/auth.ts';
import { buildWorkbook, exportFilename } from '../_shared/workbook.ts';
import type { ApplicationRow, StudentRow } from '../_shared/analytics.ts';

const PAGE = 1000;

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  const reqId = requestId();
  const who = await requireAdminUser(req);
  if (!who) {
    await serviceClient().rpc('svc_log_event', {
      p_actor: null, p_type: 'admin.export', p_outcome: 'denied', p_ip: clientIp(req), p_ua: userAgent(req), p_request: reqId, p_detail: {},
    });
    return json(req, { error: 'forbidden', message: 'This action is unavailable for your account.' }, 403);
  }
  const db = who.caller;

  try {
    // The name column is not readable directly; the administrator gets names from
    // admin_student_names(), which itself refuses anyone who is not the administrator.
    const { data: rows, error: sErr } = await db
      .from('students')
      .select('id, roll_number, profile_completed_at, last_activity_at')
      .order('roll_number');
    if (sErr) throw sErr;
    const { data: names, error: nErr } = await db.rpc('admin_student_names');
    if (nErr) throw nErr;
    const nameById = new Map((names as { student_id: string; name: string | null }[]).map((n) => [n.student_id, n.name]));
    const students = (rows as Omit<StudentRow, 'name'>[]).map((s) => ({ ...s, name: nameById.get(s.id) ?? null }));

    const applications: ApplicationRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from('applications')
        .select('*')
        .order('created_at')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      applications.push(...(data as ApplicationRow[]));
      if (!data || data.length < PAGE) break;
    }

    const now = new Date();
    const wb = buildWorkbook(ExcelJS, { students, applications, now });
    const buf = await wb.xlsx.writeBuffer();
    await serviceClient().rpc('svc_log_event', {
      p_actor: who.uid, p_type: 'admin.export', p_outcome: 'success', p_ip: clientIp(req), p_ua: userAgent(req), p_request: reqId,
      p_detail: { students: students.length, applications: applications.length },
    });
    return new Response(buf, {
      status: 200,
      headers: {
        ...corsHeaders(req),
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${exportFilename(now)}"`,
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.error('admin-export failed', e instanceof Error ? e.message : e);
    return json(req, { error: 'server_error', message: 'Export failed. Please try again.' }, 500);
  }
});
