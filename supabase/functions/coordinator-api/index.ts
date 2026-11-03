/**
 * POST — the placement coordinators' only data route. See
 * _shared/coordinator.ts for the checks applied to every request.
 */
import ExcelJS from 'npm:exceljs@4.4.0';
import { serviceClient } from '../_shared/auth.ts';
import { jwtClaims } from '../_shared/device.ts';
import { handleCoordinator } from '../_shared/coordinator.ts';
import { buildCompanyWorkbook } from '../_shared/workbook.ts';

Deno.serve(async (req) => {
  const svc = serviceClient();
  try {
    return await handleCoordinator(req, {
      async verifyToken(token) {
        // Supabase Auth validates the token; only then are its claims used.
        const { data, error } = await svc.auth.getUser(token);
        if (error || !data?.user) return null;
        const c = jwtClaims(token);
        if (!c || c.sub !== data.user.id || typeof c.session_id !== 'string') return null;
        return { uid: data.user.id, sid: c.session_id, aal: String(c.aal ?? 'aal1'), email: data.user.email ?? null };
      },
      async rpc(fn, args) {
        const { data, error } = await svc.rpc(fn, args);
        if (error) throw new Error(`${fn}: ${error.code ?? 'error'}`);
        return data;
      },
      async setPassword(uid, password) {
        const { error } = await svc.auth.admin.updateUserById(uid, { password });
        if (error) throw new Error('password update failed');
      },
      async buildExport(company, rows, now) {
        const wb = buildCompanyWorkbook(ExcelJS, { company, rows, now });
        return new Uint8Array(await wb.xlsx.writeBuffer());
      },
      now: () => Date.now(),
    });
  } catch (e) {
    console.error('coordinator-api failed', e instanceof Error ? e.message : 'error');
    return new Response(JSON.stringify({ error: 'server_error', message: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  }
});
