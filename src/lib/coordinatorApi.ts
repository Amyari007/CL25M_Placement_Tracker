/** Placement-coordinator data: every call goes through coordinator-api. */
import { jwtClaims } from '../../supabase/functions/_shared/device.ts';
import { ApiError, SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from './supabase';
import { createDeviceKey, deviceLabel, loadDeviceKey, sign } from './device';

export type CoordinatorState =
  | 'mfa_setup'
  | 'mfa_verify'
  | 'pin_setup'
  | 'pin_verify'
  | 'password_change'
  | 'device_enroll'
  | 'device_approval_required'
  | 'device_unrecognized'
  | 'ready'
  | 'unavailable';

export interface Outreach {
  company_key: string;
  display_name: string;
  outreach_status: string;
  recruitment_stage: string;
  last_contact: string | null;
  next_action: string | null;
  next_action_date: string | null;
  assessment_date: string | null;
  updated_at: string;
}

export interface CoordinatorDashboard {
  total_students: number;
  stats: { company_key: string; company: string; students: number }[];
  stages: { stage: string; count: number }[];
  upcoming: { company_key: string; company: string; date: string; stage: string }[];
  all_companies?: boolean;
  companies: { company_key: string; company: string; applicants: number; outreach: Outreach | null }[];
  refreshed_at: string;
}

export interface ApplicantList {
  company_key: string;
  company: string;
  rows: { roll_number: string; stage: string; assessment_date: string | null; applied_on: string | null; updated_at: string }[];
  generated_at: string;
}

async function session() {
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s) throw new ApiError('Please sign in again.', 401);
  const sid = String(jwtClaims(s.access_token)?.session_id ?? '');
  return { token: s.access_token, uid: s.user.id, sid };
}

async function call(action: string, payload: unknown, opts: { signWith?: CryptoKey | 'device' } = {}): Promise<Response> {
  const { token, uid, sid } = await session();
  const payloadText = JSON.stringify(payload ?? null);
  const body: Record<string, unknown> = { action, payload: payloadText };
  let key: CryptoKey | undefined;
  if (opts.signWith === 'device') key = (await loadDeviceKey(uid))?.priv;
  else if (opts.signWith) key = opts.signWith;
  if (key) body.auth = await sign(key, action, sid, payloadText);
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/coordinator-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, 'network');
  }
  if (res.status === 401) {
    // The sign-in was ended on the server (signed out, suspended, password reset).
    await supabase.auth.signOut({ scope: 'local' });
    throw new ApiError('Please sign in again.', 401);
  }
  if (!res.ok) {
    let j: { message?: string; error?: string; state?: string } = {};
    try {
      j = await res.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(j.message ?? 'Something went wrong. Please try again.', res.status, j.state ?? j.error);
  }
  return res;
}

export async function coordinatorStatus(): Promise<{ state: CoordinatorState; email?: string }> {
  return (await call('status', null, { signWith: 'device' })).json();
}

export async function setPin(pin: string): Promise<void> {
  await call('pin.set', { pin });
}

export async function verifyPin(pin: string): Promise<void> {
  await call('pin.verify', { pin });
}

export async function changeOwnPassword(password: string): Promise<void> {
  await call('account.password', { password });
}

export async function registerThisDevice(): Promise<void> {
  const { uid } = await session();
  const k = await createDeviceKey(uid);
  await call('device.enroll', { publicKey: k.pub, label: deviceLabel() }, { signWith: k.priv });
}

export async function beginSession(): Promise<void> {
  await call('session.begin', null, { signWith: 'device' });
}

export async function fetchDashboard(): Promise<CoordinatorDashboard> {
  return (await call('dashboard', null, { signWith: 'device' })).json();
}

export async function fetchApplicants(company: string): Promise<ApplicantList> {
  return (await call('applicants', { company }, { signWith: 'device' })).json();
}

export async function downloadCompanyExport(company: string): Promise<string> {
  const res = await call('export', { company }, { signWith: 'device' });
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'applicants.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

export async function updateOutreach(company: string, fields: Partial<Record<keyof Outreach, string | null>>): Promise<Outreach> {
  return (await (await call('outreach.update', { company, fields }, { signWith: 'device' })).json()).outreach;
}

export const OUTREACH_STATUS: Record<string, string> = {
  not_started: 'Not started',
  contacted: 'Contacted',
  in_discussion: 'In discussion',
  confirmed: 'Confirmed',
  on_hold: 'On hold',
  closed: 'Closed',
};
export const RECRUITMENT_STAGE: Record<string, string> = {
  not_open: 'Not open yet',
  applications_open: 'Applications open',
  assessment: 'Assessment',
  interviews: 'Interviews',
  offers: 'Offers',
  completed: 'Completed',
};
