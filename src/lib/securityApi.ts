/** Primary-administrator security controls. The database re-checks is_admin() on every call. */
import { callFunction, supabase } from './supabase';

export interface Coordinator {
  user_id: string;
  email: string;
  status: 'active' | 'suspended' | 'removed';
  must_change_password: boolean;
  password_changed_at: string | null;
  mfa_enrolled: boolean;
  device_status: 'registered' | 'revoked' | 'none';
  device_enrolled_at: string | null;
  device_last_used_at: string | null;
  device_label: string | null;
  replacement_pending: boolean;
  active_sessions: number;
  last_sign_in_at: string | null;
  companies: { company_key: string; company: string }[];
  granted_at: string;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string;
  event_type: string;
  outcome: 'success' | 'denied' | 'failure' | 'error';
  company_key: string | null;
  target_id: string | null;
  target_email: string | null;
  device_id: string | null;
  ip: string | null;
  user_agent: string | null;
  detail: Record<string, unknown>;
}

export interface SecurityAlert {
  id: number;
  created_at: string;
  last_seen_at: string;
  rule: string;
  severity: 'low' | 'medium' | 'high';
  actor_id: string | null;
  actor_email: string | null;
  subject: string | null;
  reason: string;
  occurrences: number;
  status: 'open' | 'reviewed' | 'dismissed';
  reviewed_at: string | null;
  review_note: string | null;
}

export interface OutreachRow {
  company_key: string;
  company: string;
  outreach_status: string;
  recruitment_stage: string;
  last_contact: string | null;
  next_action: string | null;
  next_action_date: string | null;
  assessment_date: string | null;
  updated_at: string | null;
  updated_by_email: string | null;
  coordinators: string[];
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const listCoordinators = () => rpc<Coordinator[]>('admin_coordinators');
export const setSuspended = (userId: string, suspend: boolean, reason?: string) =>
  rpc<void>('admin_coordinator_set_suspended', { p_user_id: userId, p_suspend: suspend, p_reason: reason ?? null });
export const revokeCoordinatorSessions = (userId: string) => rpc<number>('admin_coordinator_revoke_sessions', { p_user_id: userId });
export const deviceAction = (userId: string, allowReplacement: boolean, reason?: string) =>
  rpc<void>('admin_coordinator_device', { p_user_id: userId, p_allow_replacement: allowReplacement, p_reason: reason ?? null });
export const assignCompanies = (userId: string, companies: string[]) =>
  rpc<void>('admin_coordinator_assign', { p_user_id: userId, p_companies: companies });
export const removeCoordinator = (userId: string) => rpc<void>('admin_revoke_team', { p_user_id: userId });
export const auditEvents = (opts: { limit?: number; before?: number; type?: string; actor?: string } = {}) =>
  rpc<AuditEvent[]>('admin_audit_events', {
    p_limit: opts.limit ?? 200,
    p_before: opts.before ?? null,
    p_type: opts.type ?? null,
    p_actor: opts.actor ?? null,
  });
export const securityAlerts = (status?: string) => rpc<SecurityAlert[]>('admin_security_alerts', { p_status: status ?? null });
export const reviewAlert = (id: number, status: 'reviewed' | 'dismissed' | 'open', note?: string) =>
  rpc<void>('admin_review_alert', { p_id: id, p_status: status, p_note: note ?? null });
export const listOutreach = () => rpc<OutreachRow[]>('admin_outreach');
export const updateOutreachAsAdmin = (company: string, fields: Record<string, string | null>) =>
  rpc<unknown>('admin_outreach_update', { p_company: company, p_fields: fields });

/** Creates or re-issues a coordinator login; the temporary password is returned once. */
export async function provisionCoordinator(email: string): Promise<{ email: string; tempPassword: string }> {
  return (await callFunction('admin-team', { action: 'provision', email })).json();
}
export async function resetCoordinatorPassword(userId: string): Promise<{ email: string; tempPassword: string }> {
  return (await callFunction('admin-team', { action: 'reset_password', userId })).json();
}

export const EVENT_LABEL: Record<string, string> = {
  'auth.login': 'Sign-in',
  'coord.dashboard': 'Opened dashboard',
  'coord.applicants': 'Viewed applicant list',
  'coord.export': 'Exported applicant list',
  'coord.outreach': 'Updated outreach',
  'coord.request': 'Request',
  'coord.session': 'Session check',
  'coord.enroll': 'Device registration',
  'coord.password': 'Password change',
  'coord.pin': 'PIN entry',
  'account.pin_set': 'Chose PIN',
  'coord.export_build': 'Export build',
  'device.enroll': 'Device registration',
  'device.unrecognized': 'Unregistered browser',
  'session.begin': 'Session started',
  'session.concurrent': 'Other session signed out',
  'account.password_changed': 'Changed own password',
  'account.password_change': 'Password change',
  'admin.export': 'Administrator export',
  'admin.coordinator_provisioned': 'Coordinator login issued',
  'admin.coordinator_password_reset': 'Coordinator password reset',
  'admin.coordinator_suspended': 'Coordinator suspended',
  'admin.coordinator_reactivated': 'Coordinator reactivated',
  'admin.coordinator_removed': 'Coordinator removed',
  'admin.coordinator_change': 'Coordinator change',
  'admin.sessions_revoked': 'Sessions signed out',
  'admin.device_revoked': 'Device revoked',
  'admin.device_replacement_approved': 'Device replacement approved',
  'admin.companies_assigned': 'Companies assigned',
  'admin.alert_reviewed': 'Alert reviewed',
  'admin.outreach_updated': 'Outreach updated',
  'admin.student_code_reset': 'Student code reset',
  'admin.student_codes_reset_all': 'All student codes reset',
  'admin.student_sessions_revoked': 'Student signed out',
};

export const ALERT_LABEL: Record<string, string> = {
  repeated_exports: 'Repeated exports',
  many_companies: 'Many companies accessed',
  rapid_list_access: 'Rapid list access',
  repeated_denials: 'Repeated refused requests',
  login_failures: 'Failed sign-ins',
  unregistered_device: 'Unregistered browser',
  enrollment_attempts: 'Device registration attempts',
  frequent_device_changes: 'Frequent device changes',
  concurrent_session: 'Concurrent session',
  pin_failures: 'Wrong PINs',
};
