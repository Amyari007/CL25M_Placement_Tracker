import { AppLink } from '../../components/AppLink';
import { Form } from '../../components/Form';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Field, Input, Skeleton, Tag } from '../../components/ui/core';
import { ConfirmDialog, Dialog, useToast } from '../../components/ui/overlay';
import { addTeamMember, credentialStatus, listTeam, reapproveTeamMember, revokeSessions, revokeTeamMember, rotateAll, rotateCode, type CredentialStatus, type TeamMember } from '../../lib/adminApi';
import { useAuth } from '../../lib/auth';
import { friendlyError, supabase } from '../../lib/supabase';
import { formatDateTime } from '../../lib/format';
import { PageHeader, SectionTitle } from './PageHeader';
import { IS_LOCAL } from '../../lib/mode';

export function MfaSection({ onVerified, intro }: { onVerified?: () => void; intro?: string } = {}) {
  const toast = useToast();
  const [factors, setFactors] = useState<{ id: string; status: string }[] | null>(null);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors(data?.totp ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const verified = factors?.some((f) => f.status === 'verified');

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      // Remove abandoned unverified factors first.
      for (const f of factors ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Authenticator ${Date.now()}` });
      if (error) throw error;
      setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setCode('');
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!enroll) return;
    if (!/^\d{6}$/.test(code)) return setErr('Enter the 6-digit code.');
    setBusy(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code });
      if (error) throw error;
      setEnroll(null);
      await load();
      toast('Two-step verification is on');
      onVerified?.();
    } catch {
      setErr('That code is not valid. Check the time on your phone and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Two-step verification</h3>
            {factors === null ? null : verified ? <Tag tone="teal">On</Tag> : <Tag tone="amber">Off</Tag>}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {intro ??
              'Once enabled, batch data is released only to sessions verified with your authenticator app. The database enforces this, not just the interface.'}
          </p>
        </div>
        {factors !== null && !verified && (
          <Button variant="secondary" onClick={start} loading={busy && !enroll}>
            Set up authenticator
          </Button>
        )}
      </div>
      <Dialog
        open={!!enroll}
        onClose={() => !busy && setEnroll(null)}
        title="Set up your authenticator"
        description="Scan the QR code with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEnroll(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={verify} loading={busy}>
              Verify and turn on
            </Button>
          </>
        }
      >
        {enroll && (
          <div className="space-y-4">
            <div className="mx-auto w-44 rounded-ctl border border-line bg-white p-2">
              <img src={enroll.qr} alt="QR code for authenticator setup" className="h-full w-full" />
            </div>
            <p className="break-all text-center text-xs text-muted">
              Or enter this key: <code className="tnum rounded bg-ink-50 px-1 text-ink">{enroll.secret}</code>
            </p>
            <Field label="6-digit code" error={err}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={code}
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="tnum text-center tracking-[0.4em]"
                  data-autofocus
                />
              )}
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function CodesSection() {
  const toast = useToast();
  const [rows, setRows] = useState<CredentialStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'one' | 'all' | 'revoke'; row?: CredentialStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ rollNumber: string; code: string }[] | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await credentialStatus());
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const prototypeCount = rows?.filter((r) => r.is_prototype).length ?? 0;

  async function run() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'one' && confirm.row) setIssued([await rotateCode(confirm.row.student_id)]);
      if (confirm.kind === 'all') setIssued((await rotateAll()).codes);
      if (confirm.kind === 'revoke' && confirm.row) {
        await revokeSessions(confirm.row.student_id);
        toast(`${confirm.row.roll_number} signed out of all devices`);
      }
      setConfirm(null);
      load();
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {prototypeCount > 0 && (
        <div className="mb-4">
          <Alert tone="amber">
            <strong className="font-semibold">{prototypeCount} of 15 students are still on prototype codes.</strong> The mirror-number codes are predictable.
            Issue random codes before real use and share each one privately.
          </Alert>
        </div>
      )}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <p className="text-sm text-muted">Codes are stored only as one-way hashes. A new code is shown once.</p>
          <Button variant="secondary" size="sm" onClick={() => setConfirm({ kind: 'all' })} disabled={!rows}>
            Issue new codes for everyone
          </Button>
        </div>
        {err && (
          <div className="p-5">
            <Alert>{err}</Alert>
          </div>
        )}
        {!rows && !err && (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        )}
        {rows && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas/60 text-left text-xs text-muted">
                  <th scope="col" className="px-5 py-2.5 font-medium">Roll number</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Code</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Last changed</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Account</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.student_id}>
                    <td className="tnum px-5 py-2.5 font-medium">{r.roll_number}</td>
                    <td className="px-4 py-2.5">
                      {!r.has_code ? <Tag tone="danger">Not set</Tag> : r.is_prototype ? <Tag tone="amber">Prototype</Tag> : <Tag tone="teal">Rotated</Tag>}
                    </td>
                    <td className="tnum px-4 py-2.5 text-muted">{formatDateTime(r.rotated_at)}</td>
                    <td className="px-4 py-2.5 text-muted">{r.linked ? 'Signed in before' : 'Never signed in'}</td>
                    <td className="px-5 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="subtle" size="sm" onClick={() => setConfirm({ kind: 'one', row: r })}>
                          New code
                        </Button>
                        {r.linked && (
                          <Button variant="subtle" size="sm" onClick={() => setConfirm({ kind: 'revoke', row: r })}>
                            Sign out
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        busy={busy}
        tone={confirm?.kind === 'all' ? 'danger' : 'primary'}
        title={
          confirm?.kind === 'all'
            ? 'Issue new codes for all 15 students?'
            : confirm?.kind === 'revoke'
              ? `Sign ${confirm?.row?.roll_number} out everywhere?`
              : `Issue a new code for ${confirm?.row?.roll_number}?`
        }
        body={
          confirm?.kind === 'revoke'
            ? 'They will need to sign in again with their current code. Their data is not affected.'
            : 'Current codes stop working immediately and affected students are signed out of all devices. Their applications are kept.'
        }
        confirmLabel={confirm?.kind === 'revoke' ? 'Sign out' : 'Issue new code' + (confirm?.kind === 'all' ? 's' : '')}
        onCancel={() => setConfirm(null)}
        onConfirm={run}
      />

      <Dialog
        open={!!issued}
        onClose={() => setIssued(null)}
        size="md"
        title={issued && issued.length > 1 ? 'New access codes' : 'New access code'}
        description="Copy and share each code privately. It will not be shown again."
        footer={
          <>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText((issued ?? []).map((x) => `${x.rollNumber}\t${x.code}`).join('\n'));
                  toast('Copied to clipboard');
                } catch {
                  toast('Copy failed — select the codes manually', 'error');
                }
              }}
            >
              Copy all
            </Button>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </>
        }
      >
        <div className="max-h-[50vh] overflow-y-auto rounded-ctl border border-line">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {issued?.map((x) => (
                <tr key={x.rollNumber}>
                  <td className="tnum px-4 py-2 font-medium">{x.rollNumber}</td>
                  <td className="tnum select-all px-4 py-2 text-right font-mono text-base tracking-widest">{x.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Dialog>
    </>
  );
}


function TeamSection() {
  const toast = useToast();
  const [rows, setRows] = useState<TeamMember[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; tempPassword?: string } | null>(null);
  const [revoking, setRevoking] = useState<TeamMember | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await listTeam());
      setErr(null);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setFormErr('Enter a valid email address.');
    setBusy(true);
    setFormErr(null);
    try {
      const r = await addTeamMember(email.trim());
      setAdding(false);
      setEmail('');
      setIssued(r);
      load();
    } catch (e) {
      setFormErr((e as Error).message || friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await revokeTeamMember(revoking.user_id);
      toast(`${revoking.email} no longer has access`);
      setRevoking(null);
      load();
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <p className="max-w-xl text-sm text-muted">
            Approved members can see company-wise applicant names and roll numbers. They cannot export data, change codes or approve others.
          </p>
          <Button variant="secondary" size="sm" onClick={() => (setAdding(true), setFormErr(null))}>
            Add team member
          </Button>
        </div>
        {err && (
          <div className="p-5">
            <Alert>{err}</Alert>
          </div>
        )}
        {!rows && !err && (
          <div className="p-5">
            <Skeleton className="h-5 w-full" />
          </div>
        )}
        {rows && rows.length === 0 && <p className="px-5 py-6 text-sm text-muted">No team members yet. Only you can see applicant identities.</p>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-line">
            {rows.map((t) => (
              <li key={t.user_id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.email}</p>
                  <p className="text-xs text-muted">
                    {t.revoked_at ? `Access revoked ${formatDateTime(t.revoked_at)}` : `Approved ${formatDateTime(t.granted_at)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {t.revoked_at ? <Tag>Revoked</Tag> : <Tag tone="teal">Active</Tag>}
                  {t.revoked_at ? (
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={async () => {
                        try {
                          await reapproveTeamMember(t.email);
                          toast(`${t.email} approved again`);
                          load();
                        } catch (e) {
                          toast(friendlyError(e), 'error');
                        }
                      }}
                    >
                      Approve again
                    </Button>
                  ) : (
                    <Button variant="subtle" size="sm" onClick={() => setRevoking(t)} className="hover:!text-danger">
                      Revoke access
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog
        open={adding}
        onClose={() => !busy && setAdding(false)}
        title="Add a placement-team member"
        description="They sign in from “Administrator sign in” with this email. If the account is new, you'll get a temporary password to share privately."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={add} loading={busy}>
              Approve access
            </Button>
          </>
        }
      >
        <Form
          onSubmit={() => {
            add();
          }}
        >
          <Field label="Email" error={formErr}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="email" aria-describedby={describedBy} aria-invalid={invalid} value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus />
            )}
          </Field>
        </Form>
      </Dialog>

      <Dialog
        open={!!issued}
        onClose={() => setIssued(null)}
        title="Team member approved"
        description={issued?.tempPassword ? 'Share these sign-in details privately. The password is shown only once.' : 'This account already existed; they can sign in with their current password.'}
        footer={<Button onClick={() => setIssued(null)}>Done</Button>}
      >
        <div className="rounded-ctl border border-line">
          <div className="flex justify-between gap-4 border-b border-line px-4 py-2 text-sm">
            <span className="text-muted">Email</span>
            <span className="font-medium">{issued?.email}</span>
          </div>
          {issued?.tempPassword && (
            <div className="flex justify-between gap-4 px-4 py-2 text-sm">
              <span className="text-muted">Temporary password</span>
              <span className="select-all font-mono tracking-wide">{issued.tempPassword}</span>
            </div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!revoking}
        busy={busy}
        title={`Revoke access for ${revoking?.email ?? ''}?`}
        body="They immediately lose access to applicant names and records and are signed out. You can approve them again later."
        confirmLabel="Revoke access"
        onCancel={() => setRevoking(null)}
        onConfirm={revoke}
      />
    </>
  );
}

export default function Settings() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  return (
    <>
      <PageHeader title="Settings" subtitle={isAdmin ? "Security, team access and student codes" : "Your account security"} />
      <SectionTitle>{isAdmin ? "Administrator security" : "Account security"}</SectionTitle>
      {IS_LOCAL ? (
        <div className="card p-5">
          <h3 className="text-sm font-semibold">Offline version</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Everything is saved only in this browser on this device. Two-step verification and shared access across phones need the hosted
            version (Supabase), included separately.
          </p>
        </div>
      ) : (
        <MfaSection />
      )}
      {isAdmin && (
        <>
          <SectionTitle>Placement coordinators</SectionTitle>
          {IS_LOCAL ? (
            <TeamSection />
          ) : (
            <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
              <p className="max-w-xl text-sm text-muted">Coordinator logins, their registered computers, companies, alerts and the activity log are on the Security page.</p>
              <AppLink to="/admin/security" className="text-sm font-medium text-teal hover:underline">
                Open Security →
              </AppLink>
            </div>
          )}
          <SectionTitle>Student access codes</SectionTitle>
          <CodesSection />
        </>
      )}
      <SectionTitle>Privacy</SectionTitle>
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <p className="max-w-xl text-sm text-muted">Students can read the privacy notice from the sign-in page and their account menu.</p>
        <AppLink to="/privacy" className="text-sm font-medium text-teal hover:underline">
          View privacy notice →
        </AppLink>
      </div>
    </>
  );
}
