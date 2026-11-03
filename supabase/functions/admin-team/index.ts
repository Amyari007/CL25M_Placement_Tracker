/**
 * POST (administrator only) — coordinator accounts:
 *   { action: 'provision', email } and { action: 'reset_password', userId }.
 * See _shared/adminSecurity.ts.
 */
import { requireAdminUser, serviceClient } from '../_shared/auth.ts';
import { handleAdminSecurity } from '../_shared/adminSecurity.ts';

Deno.serve(async (req) => {
  const svc = serviceClient();
  return await handleAdminSecurity(req, {
    async requireAdmin(r) {
      const a = await requireAdminUser(r);
      return a ? { uid: a.uid } : null;
    },
    async rpc(fn, args) {
      const { data, error } = await svc.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.code ?? 'error'}`);
      return data;
    },
    async findUserId(email) {
      const { data, error } = await svc.rpc('find_user_id_by_email', { p_email: email });
      if (error) throw new Error('lookup failed');
      return (data as string | null) ?? null;
    },
    async createUser(email, password) {
      const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { role: 'coordinator' } });
      if (error || !data.user) throw new Error('create failed');
      return data.user.id;
    },
    async setPassword(uid, password) {
      const { error } = await svc.auth.admin.updateUserById(uid, { password });
      if (error) throw new Error('password update failed');
    },
  });
});
