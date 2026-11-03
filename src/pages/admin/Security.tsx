import { useCallback, useEffect, useState } from 'react';
import { Form } from '../../components/Form';
import { Alert, Button, Field, Input, Select, Skeleton, Tag, Textarea } from '../../components/ui/core';
import { ConfirmDialog, Dialog, useToast } from '../../components/ui/overlay';
import { friendlyError } from '../../lib/supabase';
import { formatDate, formatDateTime } from '../../lib/format';
import { OUTREACH_STATUS, RECRUITMENT_STAGE } from '../../lib/coordinatorApi';
import {
  ALERT_LABEL,
  EVENT_LABEL,
  assignCompanies,
  auditEvents,
  deviceAction,
  listCoordinators,
  listOutreach,
  provisionCoordinator,
  removeCoordinator,
  resetCoordinatorPassword,
  reviewAlert,
  revokeCoordinatorSessions,
  securityAlerts,
  setSuspended,
  type AuditEvent,
  type Coordinator,
  type OutreachRow,
  type SecurityAlert,
} from '../../lib/securityApi';
import { PageHeader, SectionTitle } from './PageHeader';

type Pending =
  | { kind: 'suspend' | 'reactivate' | 'sessions' | 'device_revoke' | 'device_replace' | 'reset' | 'remove'; c: Coordinator }
  | null;

const CONFIRM: Record<NonNullable<Pending>['kind'], { title: string; body: string; label: string }> = {
  suspend: { title: 'Suspend this coordinator?', body: 'They are signed out and every request is refused until you reactivate them. The other coordinators are not affected.', label: 'Suspend' },
  reactivate: { title: 'Reactivate this coordinator?', body: 'They can sign in again from their registered computer.', label: 'Reactivate' },
  sessions: { title: 'Sign this coordinator out everywhere?', body: 'All of their sign-ins end now. They can sign in again from their registered computer.', label: 'Sign out' },
  device_revoke: { title: 'Revoke the registered computer?', body: 'The computer stops working immediately and they cannot register another one until you approve a replacement.', label: 'Revoke computer' },
  device_replace: { title: 'Approve a new computer?', body: 'The current computer stops working now. Within 48 hours they may register ONE new computer after signing in with their password and PIN.', label: 'Approve replacement' },
  reset: { title: 'Issue a new temporary password?', body: 'Their current password and PIN stop working and they are signed out. They choose a new PIN and password after signing in.', label: 'Reset password' },
  remove: { title: 'Remove this coordinator?', body: 'Their access ends now and their registered computer is revoked. You can issue a new login later.', label: 'Remove' },
};

function CoordinatorsSection() {
  const toast = useToast();
  const [rows, setRows] = useState<Coordinator[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; tempPassword: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [assigning, setAssigning] = useState<Coordinator | null>(null);
  const [companies, setCompanies] = useState('');
  const [allCompanies, setAllCompanies] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await listCoordinators());
      setErr(null);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function provision() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setFormErr('Enter a valid email address.');
    setBusy(true);
    setFormErr(null);
    try {
      const r = await provisionCoordinator(email.trim());
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

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      const id = pending.c.user_id;
      if (pending.kind === 'suspend') await setSuspended(id, true, reason);
      if (pending.kind === 'reactivate') await setSuspended(id, false);
      if (pending.kind === 'sessions') await revokeCoordinatorSessions(id);
      if (pending.kind === 'device_revoke') await deviceAction(id, false, reason);
      if (pending.kind === 'device_replace') await deviceAction(id, true, reason);
      if (pending.kind === 'remove') await removeCoordinator(id);
      if (pending.kind === 'reset') setIssued(await resetCoordinatorPassword(id));
      else toast('Saved');
      setPending(null);
      setReason('');
      load();
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveCompanies() {
    if (!assigning) return;
    setBusy(true);
    try {
      await assignCompanies(
        assigning.user_id,
        allCompanies ? ['*'] : companies.split(/\n|,/).map((s) => s.trim()).filter(Boolean),
      );
      toast('Companies saved');
      setAssigning(null);
      load();
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const statusTag = (c: Coordinator) =>
    c.status === 'active' ? <Tag tone="teal">Active</Tag> : c.status === 'suspended' ? <Tag tone="amber">Suspended</Tag> : <Tag>Removed</Tag>;

  return (
    <>
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <p className="max-w-xl text-sm text-muted">
            Coordinators see batch totals, and roll numbers only for the companies you assign. They never see names, codes or other settings.
          </p>
          <Button variant="secondary" size="sm" onClick={() => (setAdding(true), setFormErr(null))}>
            Add coordinator
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
        {rows && rows.length === 0 && <p className="px-5 py-6 text-sm text-muted">No coordinators yet.</p>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-line">
            {rows.map((c) => (
              <li key={c.user_id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold">{c.email}</p>
                      {statusTag(c)}
                    </div>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
                      <div>
                        PIN: <span className={c.mfa_enrolled ? 'text-teal-700' : 'text-amber'}>{c.mfa_enrolled ? 'chosen' : 'not chosen yet'}</span>
                      </div>
                      <div>
                        Password: <span className={c.must_change_password ? 'text-amber' : 'text-teal-700'}>{c.must_change_password ? 'temporary, not yet changed' : `own (since ${formatDate(c.password_changed_at?.slice(0, 10))})`}</span>
                      </div>
                      <div>
                        Computer:{' '}
                        {c.device_status === 'registered' ? (
                          <span className="text-teal-700">
                            {c.device_label ?? 'registered'} · {formatDate(c.device_enrolled_at?.slice(0, 10))}
                          </span>
                        ) : c.replacement_pending ? (
                          <span className="text-amber">replacement approved, waiting</span>
                        ) : (
                          <span className="text-amber">{c.device_status === 'revoked' ? 'revoked' : 'not registered'}</span>
                        )}
                      </div>
                      <div>
                        Last used: {c.device_last_used_at ? formatDateTime(c.device_last_used_at) : '—'} · {c.active_sessions} sign-in
                        {c.active_sessions === 1 ? '' : 's'} open
                      </div>
                      <div className="sm:col-span-2">
                        Companies: {c.companies.length ? c.companies.map((x) => x.company).join(', ') : <span className="text-amber">none assigned</span>}
                      </div>
                    </dl>
                  </div>
                  {c.status !== 'removed' && (
                    <div className="flex flex-wrap gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => (
                          setAssigning(c),
                          setAllCompanies(c.companies.some((x) => x.company_key === '*')),
                          setCompanies(c.companies.filter((x) => x.company_key !== '*').map((x) => x.company).join('\n'))
                        )}>
                        Companies
                      </Button>
                      {c.status === 'active' ? (
                        <Button variant="subtle" size="sm" onClick={() => setPending({ kind: 'suspend', c })}>
                          Suspend
                        </Button>
                      ) : (
                        <Button variant="subtle" size="sm" onClick={() => setPending({ kind: 'reactivate', c })}>
                          Reactivate
                        </Button>
                      )}
                      <Button variant="subtle" size="sm" onClick={() => setPending({ kind: 'sessions', c })}>
                        Sign out
                      </Button>
                      <Button variant="subtle" size="sm" onClick={() => setPending({ kind: 'device_replace', c })}>
                        New computer
                      </Button>
                      {c.device_status === 'registered' && (
                        <Button variant="subtle" size="sm" onClick={() => setPending({ kind: 'device_revoke', c })}>
                          Revoke computer
                        </Button>
                      )}
                      <Button variant="subtle" size="sm" onClick={() => setPending({ kind: 'reset', c })}>
                        Reset password
                      </Button>
                      <Button variant="subtle" size="sm" className="hover:!text-danger" onClick={() => setPending({ kind: 'remove', c })}>
                        Remove
                      </Button>
                    </div>
                  )}
                  {c.status === 'removed' && (
                    <Button variant="subtle" size="sm" onClick={() => (setEmail(c.email), setAdding(true))}>
                      Issue new login
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
        title="Add a coordinator"
        description="An existing login is reused and its old password replaced. You'll get a temporary password to give them privately (in person or a direct call, not a group chat)."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={provision} loading={busy}>
              Issue login
            </Button>
          </>
        }
      >
        <Form onSubmit={() => provision()}>
          <Field label="Institute email" error={formErr}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="email" aria-describedby={describedBy} aria-invalid={invalid} value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus />
            )}
          </Field>
        </Form>
      </Dialog>

      <Dialog
        open={!!issued}
        onClose={() => setIssued(null)}
        title="Temporary sign-in details"
        description="Shown only once. On first sign-in they choose a 6-digit PIN and their own password, then register their computer."
        footer={<Button onClick={() => setIssued(null)}>Done</Button>}
      >
        <div className="rounded-ctl border border-line">
          <div className="flex justify-between gap-4 border-b border-line px-4 py-2 text-sm">
            <span className="text-muted">Email</span>
            <span className="font-medium">{issued?.email}</span>
          </div>
          <div className="flex justify-between gap-4 px-4 py-2 text-sm">
            <span className="text-muted">Temporary password</span>
            <span className="select-all font-mono tracking-wide">{issued?.tempPassword}</span>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pending}
        busy={busy}
        title={pending ? `${CONFIRM[pending.kind].title} (${pending.c.email})` : ''}
        body={
          <div className="space-y-3">
            <p>{pending ? CONFIRM[pending.kind].body : ''}</p>
            {pending && ['suspend', 'device_revoke', 'device_replace'].includes(pending.kind) && (
              <Field label="Reason (kept in the audit log)" optional>
                {({ id }) => <Input id={id} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
            )}
          </div>
        }
        confirmLabel={pending ? CONFIRM[pending.kind].label : ''}
        onCancel={() => (setPending(null), setReason(''))}
        onConfirm={confirm}
      />

      <Dialog
        open={!!assigning}
        onClose={() => !busy && setAssigning(null)}
        title={`Companies for ${assigning?.email ?? ''}`}
        description="One company per line. Spelling differences are matched the same way as student entries. The coordinator sees roll numbers only for these companies."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssigning(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={saveCompanies} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-ctl border border-line p-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#0F766E]" checked={allCompanies} onChange={(e) => setAllCompanies(e.target.checked)} />
          <span>
            <span className="font-medium">All companies</span>
            <span className="block text-xs text-muted">Roll-number lists and exports for every company, including ones added later. Names stay hidden.</span>
          </span>
        </label>
        <Field label="Or only these companies">
          {({ id }) => (
            <Textarea id={id} rows={8} value={companies} disabled={allCompanies} onChange={(e) => setCompanies(e.target.value)} data-autofocus />
          )}
        </Field>
      </Dialog>
    </>
  );
}

function AlertsSection() {
  const toast = useToast();
  const [rows, setRows] = useState<SecurityAlert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const load = useCallback(async () => {
    try {
      setRows(await securityAlerts(show === 'open' ? 'open' : undefined));
      setErr(null);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, [show]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <p className="text-sm text-muted">Patterns worth a look. An alert is a prompt to check, not proof of misuse.</p>
        <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')} className="w-32">
          <option value="open">Open</option>
          <option value="all">All</option>
        </Select>
      </div>
      {err && (
        <div className="p-5">
          <Alert>{err}</Alert>
        </div>
      )}
      {rows && rows.length === 0 && <p className="px-5 py-6 text-sm text-muted">No {show === 'open' ? 'open ' : ''}alerts.</p>}
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold">{ALERT_LABEL[a.rule] ?? a.rule}</p>
                  <Tag tone={a.severity === 'high' ? 'danger' : a.severity === 'medium' ? 'amber' : 'neutral'}>{a.severity}</Tag>
                  {a.status !== 'open' && <Tag>{a.status}</Tag>}
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {a.actor_email ?? a.subject ?? 'Unknown account'} · {a.reason} · first {formatDateTime(a.created_at)}, last {formatDateTime(a.last_seen_at)}
                  {a.occurrences > 1 ? ` · ${a.occurrences}×` : ''}
                </p>
                {a.review_note && <p className="mt-0.5 text-xs text-muted">Note: {a.review_note}</p>}
              </div>
              {a.status === 'open' && (
                <div className="flex gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await reviewAlert(a.id, 'reviewed');
                        load();
                      } catch (e) {
                        toast(friendlyError(e), 'error');
                      }
                    }}
                  >
                    Mark reviewed
                  </Button>
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={async () => {
                      try {
                        await reviewAlert(a.id, 'dismissed');
                        load();
                      } catch (e) {
                        toast(friendlyError(e), 'error');
                      }
                    }}
                  >
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AuditSection() {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [more, setMore] = useState(true);
  const load = useCallback(async (before?: number) => {
    try {
      const r = await auditEvents({ limit: 100, before, type: type || undefined });
      setRows((prev) => (before ? [...(prev ?? []), ...r] : r));
      setMore(r.length === 100);
      setErr(null);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, [type]);
  useEffect(() => {
    load();
  }, [load]);
  const tone = (o: AuditEvent['outcome']) => (o === 'success' ? 'teal' : o === 'denied' ? 'amber' : 'danger') as 'teal' | 'amber' | 'danger';
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <p className="text-sm text-muted">Recorded on the server. Entries cannot be edited or deleted from the app.</p>
        <Select aria-label="Filter events" value={type} onChange={(e) => setType(e.target.value)} className="w-48">
          <option value="">All events</option>
          <option value="auth.">Sign-ins</option>
          <option value="coord.">Coordinator activity</option>
          <option value="device.">Device events</option>
          <option value="admin.">Administrator actions</option>
        </Select>
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
      {rows && rows.length === 0 && <p className="px-5 py-6 text-sm text-muted">No events yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-canvas text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Time (IST)</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Result</th>
                <th className="px-4 py-2 font-medium">Details</th>
                <th className="px-4 py-2 font-medium">Reported IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-xs">{formatDateTime(e.at)}</td>
                  <td className="px-4 py-2 text-xs">{e.actor_email ?? (e.actor_role === 'student' ? 'student' : e.actor_role === 'anonymous' ? 'not signed in' : e.actor_role)}</td>
                  <td className="px-4 py-2 text-xs">{EVENT_LABEL[e.event_type] ?? e.event_type}</td>
                  <td className="px-4 py-2">
                    <Tag tone={tone(e.outcome)}>{e.outcome}</Tag>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {[e.company_key && `company: ${e.company_key}`, e.target_email && `for: ${e.target_email}`, ...Object.entries(e.detail ?? {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-muted">{e.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && more && (
        <div className="border-t border-line px-5 py-3">
          <Button variant="subtle" size="sm" onClick={() => load(rows[rows.length - 1]?.id)}>
            Load older events
          </Button>
        </div>
      )}
    </div>
  );
}

function OutreachSection() {
  const [rows, setRows] = useState<OutreachRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    listOutreach()
      .then((r) => (setRows(r), setErr(null)))
      .catch((e) => setErr(friendlyError(e)));
  }, []);
  return (
    <div className="card overflow-hidden">
      {err && (
        <div className="p-5">
          <Alert>{err}</Alert>
        </div>
      )}
      {rows && rows.length === 0 && <p className="px-5 py-6 text-sm text-muted">No companies assigned or tracked yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-canvas text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Stage</th>
                <th className="px-4 py-2 font-medium">Next action</th>
                <th className="px-4 py-2 font-medium">Coordinators</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((o) => (
                <tr key={o.company_key} className="align-top">
                  <td className="px-4 py-2 font-medium">{o.company}</td>
                  <td className="px-4 py-2">{OUTREACH_STATUS[o.outreach_status] ?? o.outreach_status}</td>
                  <td className="px-4 py-2">{RECRUITMENT_STAGE[o.recruitment_stage] ?? o.recruitment_stage}</td>
                  <td className="px-4 py-2 text-xs">
                    {o.next_action ?? '—'}
                    {o.next_action_date ? ` (${formatDate(o.next_action_date)})` : ''}
                  </td>
                  <td className="px-4 py-2 text-xs">{o.coordinators.join(', ') || '—'}</td>
                  <td className="px-4 py-2 text-xs text-muted">{o.updated_at ? `${formatDateTime(o.updated_at)}${o.updated_by_email ? ` · ${o.updated_by_email}` : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Security() {
  const [rev, setRev] = useState(0);
  return (
    <>
      <PageHeader
        title="Security"
        subtitle="Coordinator accounts, alerts and the activity log"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setRev((n) => n + 1)}>
            Refresh
          </Button>
        }
      />
      <div key={rev}>
        <SectionTitle>Placement coordinators</SectionTitle>
        <CoordinatorsSection />
        <SectionTitle>Alerts</SectionTitle>
        <AlertsSection />
        <SectionTitle>Company outreach</SectionTitle>
        <OutreachSection />
        <SectionTitle>Activity log</SectionTitle>
        <AuditSection />
      </div>
    </>
  );
}
