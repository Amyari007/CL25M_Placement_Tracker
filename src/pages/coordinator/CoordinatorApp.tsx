import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Form } from '../../components/Form';
import { Alert, Button, EmptyState, Field, Input, Select, Skeleton, StageBadge, StatCard, Tag, Wordmark } from '../../components/ui/core';
import { Dialog, Menu, MenuItem, Sheet, useToast } from '../../components/ui/overlay';
import { useAuth } from '../../lib/auth';
import { ApiError, friendlyError } from '../../lib/supabase';
import { formatDate, formatDateTime, relativeDay } from '../../lib/format';
import {
  OUTREACH_STATUS,
  RECRUITMENT_STAGE,
  beginSession,
  changeOwnPassword,
  setPin,
  verifyPin,
  coordinatorStatus,
  downloadCompanyExport,
  fetchApplicants,
  fetchDashboard,
  registerThisDevice,
  updateOutreach,
  type ApplicantList,
  type CoordinatorDashboard,
  type CoordinatorState,
} from '../../lib/coordinatorApi';
import { STAGE_LABEL, todayISO, type Stage } from '../../../supabase/functions/_shared/analytics.ts';
import { MfaSection } from '../admin/Settings';
import { PageHeader, SectionTitle } from '../admin/PageHeader';

const CompanyPie = lazy(() => import('../../components/CompanyPie'));

function Shell({ email, children }: { email?: string; children: ReactNode }) {
  const { signOut, session } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Wordmark />
            <Tag tone="teal">Coordinator</Tag>
          </div>
          <Menu
            label="Account menu"
            trigger={
              <span className="grid h-8 w-8 place-items-center rounded-full border border-line-strong text-xs font-semibold text-ink" aria-hidden="true">
                PC
              </span>
            }
          >
            {(close) => (
              <>
                <div className="border-b border-line px-3.5 pb-2.5 pt-1.5">
                  <p className="text-xs text-muted">Signed in as</p>
                  <p className="truncate text-sm font-medium">{email ?? session?.user.email}</p>
                </div>
                <MenuItem tone="danger" onClick={() => (close(), signOut())}>
                  Sign out
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">{children}</main>
    </div>
  );
}

function StepCard({ step, title, children }: { step?: string; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl">
      {step && <p className="eyebrow">{step}</p>}
      <h1 className="mt-2 text-xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}

function PinStep({ mode, onDone }: { mode: 'setup' | 'verify'; onDone: () => void }) {
  const [pin, setPinValue] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  return (
    <StepCard step={mode === 'setup' ? 'Step 1 of 3' : undefined} title={mode === 'setup' ? 'Choose a 6-digit PIN' : 'Enter your PIN'}>
      <p className="text-sm leading-relaxed text-muted">
        {mode === 'setup'
          ? 'You will type this PIN after your password every time you sign in. Do not use your access code, birthday or 123456.'
          : 'Type the 6-digit PIN you chose.'}
      </p>
      <Form
        noValidate
        className="space-y-4"
        onSubmit={async () => {
          if (pin.length !== 6) return setErr('Enter all 6 digits.');
          if (mode === 'setup' && pin !== pin2) return setErr('The two PINs do not match.');
          setBusy(true);
          setErr(null);
          try {
            if (mode === 'setup') await setPin(pin);
            else await verifyPin(pin);
            onDone();
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : friendlyError(e));
            setPinValue('');
            setPin2('');
          } finally {
            setBusy(false);
          }
        }}
      >
        {err && <Alert>{err}</Alert>}
        <Field label={mode === 'setup' ? 'New PIN' : 'PIN'}>
          {({ id }) => (
            <Input id={id} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin}
              onChange={(e) => setPinValue(digits(e.target.value))} className="tnum text-center text-lg tracking-[0.4em]" data-autofocus />
          )}
        </Field>
        {mode === 'setup' && (
          <Field label="Type the PIN again">
            {({ id }) => (
              <Input id={id} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin2}
                onChange={(e) => setPin2(digits(e.target.value))} className="tnum text-center text-lg tracking-[0.4em]" />
            )}
          </Field>
        )}
        <Button type="submit" loading={busy}>
          {mode === 'setup' ? 'Save PIN' : 'Continue'}
        </Button>
      </Form>
    </StepCard>
  );
}

function PasswordStep({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <StepCard step="Step 2 of 3" title="Choose your own password">
      <p className="text-sm leading-relaxed text-muted">The temporary password you were given stops working once you set your own.</p>
      <Form
        noValidate
        className="space-y-4"
        onSubmit={async () => {
          if (pw.length < 12) return setErr('Use at least 12 characters.');
          if (pw !== pw2) return setErr('The two passwords do not match.');
          setBusy(true);
          setErr(null);
          try {
            await changeOwnPassword(pw);
            onDone();
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : friendlyError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {err && <Alert>{err}</Alert>}
        <Field label="New password" hint="At least 12 characters. A short phrase works well.">
          {({ id, describedBy }) => (
            <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} value={pw} onChange={(e) => setPw(e.target.value)} data-autofocus />
          )}
        </Field>
        <Field label="Confirm new password">
          {({ id }) => <Input id={id} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy}>
          Save password
        </Button>
      </Form>
    </StepCard>
  );
}

function DeviceStep({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <StepCard step="Step 3 of 3" title="Register this computer">
      <p className="text-sm leading-relaxed text-muted">
        Coordinator tools work only on one registered computer and browser. Do this on your own computer, not a shared or lab one. To change
        computers later, ask the administrator.
      </p>
      {err && <Alert>{err}</Alert>}
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await registerThisDevice();
            onDone();
          } catch (e) {
            setErr(e instanceof ApiError ? e.message : friendlyError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Register this computer
      </Button>
    </StepCard>
  );
}

const STAGE_ORDER: Stage[] = ['applied', 'assessment_scheduled', 'interview', 'offer_received', 'rejected', 'withdrawn'];

function OutreachDialog({
  company,
  initial,
  onClose,
  onSaved,
}: {
  company: CoordinatorDashboard['companies'][number] | null;
  initial: Record<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(initial), [initial]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog
      open={!!company}
      onClose={() => !busy && onClose()}
      title={`Outreach: ${company?.company ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              if (!company) return;
              setBusy(true);
              setErr(null);
              try {
                await updateOutreach(company.company, f);
                toast('Outreach saved');
                onSaved();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : friendlyError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {err && (
          <div className="sm:col-span-2">
            <Alert>{err}</Alert>
          </div>
        )}
        <Field label="Outreach status">
          {({ id }) => (
            <Select id={id} value={f.outreach_status ?? 'not_started'} onChange={set('outreach_status')}>
              {Object.entries(OUTREACH_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Recruitment stage">
          {({ id }) => (
            <Select id={id} value={f.recruitment_stage ?? 'not_open'} onChange={set('recruitment_stage')}>
              {Object.entries(RECRUITMENT_STAGE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Last contact" optional>
          {({ id }) => <Input id={id} type="date" value={f.last_contact ?? ''} onChange={set('last_contact')} />}
        </Field>
        <Field label="Assessment date" optional>
          {({ id }) => <Input id={id} type="date" value={f.assessment_date ?? ''} onChange={set('assessment_date')} />}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Next action" optional>
            {({ id }) => <Input id={id} maxLength={300} value={f.next_action ?? ''} onChange={set('next_action')} />}
          </Field>
        </div>
        <Field label="Next action due" optional>
          {({ id }) => <Input id={id} type="date" value={f.next_action_date ?? ''} onChange={set('next_action_date')} />}
        </Field>
      </div>
    </Dialog>
  );
}

function Dashboard() {
  const toast = useToast();
  const [d, setD] = useState<CoordinatorDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [list, setList] = useState<ApplicantList | null>(null);
  const [listFor, setListFor] = useState<string | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [editing, setEditing] = useState<CoordinatorDashboard['companies'][number] | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await fetchDashboard());
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : friendlyError(e));
    }
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(() => document.visibilityState === 'visible' && load(), 120_000);
    return () => clearInterval(iv);
  }, [load]);

  async function openList(company: string) {
    setListFor(company);
    setList(null);
    setListErr(null);
    try {
      setList(await fetchApplicants(company));
    } catch (e) {
      setListErr(e instanceof ApiError ? e.message : friendlyError(e));
    }
  }
  async function exportList(company: string) {
    setExporting(company);
    try {
      toast(`Downloaded ${await downloadCompanyExport(company)}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : friendlyError(e), 'error');
    } finally {
      setExporting(null);
    }
  }

  const relTotal = d ? d.stats.reduce((n, s) => n + s.students, 0) : 0;
  const stageMax = d ? Math.max(1, ...d.stages.map((s) => s.count)) : 1;
  const today = todayISO();
  const editInitial = useMemo<Record<string, string>>(
    () =>
      editing?.outreach
        ? Object.fromEntries(
            ['outreach_status', 'recruitment_stage', 'last_contact', 'next_action', 'next_action_date', 'assessment_date'].map((k) => [
              k,
              String((editing.outreach as unknown as Record<string, unknown>)[k] ?? ''),
            ]),
          )
        : {},
    [editing],
  );

  return (
    <>
      <PageHeader
        title="Placement coordination"
        subtitle={d?.all_companies ? 'Batch totals and all companies' : 'Batch totals and your assigned companies'}
        actions={
          <Button variant="secondary" size="sm" onClick={load}>
            Refresh
          </Button>
        }
      />
      {err && <Alert>{err}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Students in batch" value={d?.total_students ?? 0} loading={!d} />
        <StatCard label="Companies applied to" value={d?.stats.length ?? 0} loading={!d} tone="teal" />
        <StatCard label="Applications" value={relTotal} loading={!d} tone="muted" />
        <StatCard label="Your companies" value={d?.companies.length ?? 0} loading={!d} tone="amber" />
      </div>

      <SectionTitle hint={d ? `Updated ${formatDateTime(d.refreshed_at)} IST` : undefined}>Your companies</SectionTitle>
      {!d && <Skeleton className="h-24 w-full" />}
      {d && d.companies.length === 0 && (
        <div className="card">
          <EmptyState title="No companies assigned yet" body="The administrator assigns companies to coordinators. They will appear here." />
        </div>
      )}
      {d && d.companies.length > 0 && (
        <div className="card overflow-hidden">
          <ul className="divide-y divide-line">
            {d.companies.map((c) => (
              <li key={c.company_key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{c.company}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {c.applicants} {c.applicants === 1 ? 'applicant' : 'applicants'} ·{' '}
                    {OUTREACH_STATUS[c.outreach?.outreach_status ?? 'not_started']} · {RECRUITMENT_STAGE[c.outreach?.recruitment_stage ?? 'not_open']}
                    {c.outreach?.next_action ? ` · Next: ${c.outreach.next_action}` : ''}
                    {c.outreach?.next_action_date ? ` (${formatDate(c.outreach.next_action_date)})` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => openList(c.company)}>
                    Applicants
                  </Button>
                  <Button variant="secondary" size="sm" loading={exporting === c.company} onClick={() => exportList(c.company)}>
                    Export
                  </Button>
                  <Button variant="subtle" size="sm" onClick={() => setEditing(c)}>
                    Outreach
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-base font-semibold tracking-tight">How many students applied to each company?</h2>
          <p className="-mt-2 mb-3 text-xs text-muted">Click a company to see the roll numbers of its applicants.</p>
          <div className="card p-5">
            {d && d.stats.length > 0 ? (
              <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
                <CompanyPie
                  rows={d.stats.map((s) => ({ key: s.company_key, name: s.company, value: s.students }))}
                  total={relTotal}
                  onSelect={(r) => openList(r.name)}
                />
              </Suspense>
            ) : (
              <p className="text-sm text-muted">{d ? 'No applications yet.' : ''}</p>
            )}
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-base font-semibold tracking-tight">Applications by stage</h2>
          <div className="card space-y-3 p-5">
            {STAGE_ORDER.map((st) => {
              const n = d?.stages.find((x) => x.stage === st)?.count ?? 0;
              return (
                <div key={st} className="grid grid-cols-[150px_1fr_32px] items-center gap-3 text-sm">
                  <span className="text-muted">{STAGE_LABEL[st]}</span>
                  <span className="h-2.5 rounded bg-ink-50">
                    <span className="block h-2.5 rounded bg-ink" style={{ width: `${(n / stageMax) * 100}%` }} />
                  </span>
                  <span className="tnum text-right font-medium">{n}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <SectionTitle hint="Next 45 days · soonest first">Upcoming assessments</SectionTitle>
      <div className="card overflow-hidden">
        {d && d.upcoming.length === 0 && <p className="px-5 py-6 text-sm text-muted">No assessment dates in the next 45 days.</p>}
        {d && d.upcoming.length > 0 && (
          <ul className="divide-y divide-line">
            {d.upcoming.map((u, i) => {
              const rel = relativeDay(today, u.date);
              return (
                <li key={`${u.company_key}-${u.date}-${i}`} className="grid grid-cols-[92px_1fr_auto] items-center gap-4 px-5 py-3">
                  <div>
                    <p className="text-sm font-semibold">{formatDate(u.date)}</p>
                    {rel && <p className="text-xs text-amber">{rel}</p>}
                  </div>
                  <button type="button" onClick={() => openList(u.company)} className="min-w-0 truncate text-left text-sm font-medium hover:text-teal hover:underline">
                    {u.company}
                  </button>
                  <StageBadge stage={u.stage as Stage} />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Sheet
        open={!!listFor}
        onClose={() => setListFor(null)}
        title={list?.company ?? listFor ?? ''}
        subtitle="Applicants by roll number"
        footer={
          <>
            <Button variant="secondary" onClick={() => setListFor(null)}>
              Close
            </Button>
            {listFor && (
              <Button loading={exporting === listFor} onClick={() => exportList(listFor)}>
                Export .xlsx
              </Button>
            )}
          </>
        }
      >
        {listErr && <Alert>{listErr}</Alert>}
        {!list && !listErr && <Skeleton className="h-24 w-full" />}
        {list && list.rows.length === 0 && <p className="text-sm text-muted">No applicants yet.</p>}
        {list && list.rows.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Roll number</th>
                <th className="pb-2 font-medium">Stage</th>
                <th className="pb-2 font-medium">Assessment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.rows.map((r) => (
                <tr key={r.roll_number}>
                  <td className="tnum py-2 font-medium">{r.roll_number}</td>
                  <td className="py-2">{STAGE_LABEL[r.stage as Stage] ?? r.stage}</td>
                  <td className="py-2">{r.assessment_date ? formatDate(r.assessment_date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Sheet>

      <OutreachDialog company={editing} initial={editInitial} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />
    </>
  );
}

export default function CoordinatorApp() {
  const { completeMfa, signOut } = useAuth();
  const [state, setState] = useState<CoordinatorState | 'loading' | 'error'>('loading');
  const [email, setEmail] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const began = useRef(false);

  const refresh = useCallback(async () => {
    setState('loading');
    try {
      const s = await coordinatorStatus();
      setEmail(s.email);
      if (s.state === 'ready' && !began.current) {
        began.current = true;
        await beginSession();
      }
      setState(s.state);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : friendlyError(e));
      setState('error');
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  let body: ReactNode;
  if (state === 'loading') body = <Skeleton className="mx-auto h-32 max-w-xl" />;
  else if (state === 'error')
    body = (
      <StepCard title="Something went wrong">
        <Alert>{error}</Alert>
        <Button variant="secondary" onClick={refresh}>
          Try again
        </Button>
      </StepCard>
    );
  else if (state === 'pin_setup') body = <PinStep mode="setup" onDone={refresh} />;
  else if (state === 'pin_verify') body = <PinStep mode="verify" onDone={refresh} />;
  else if (state === 'mfa_setup')
    body = (
      <StepCard step="Step 1 of 3" title="Turn on two-step verification">
        <MfaSection onVerified={refresh} intro="You'll enter a code from your authenticator app each time you sign in." />
      </StepCard>
    );
  else if (state === 'mfa_verify')
    body = (
      <StepCard title="Two-step verification">
        {error && <Alert>{error}</Alert>}
        <Form
          noValidate
          className="space-y-4"
          onSubmit={async () => {
            try {
              await completeMfa(otp);
              refresh();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : friendlyError(e));
            }
          }}
        >
          <Field label="6-digit code">
            {({ id }) => (
              <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
            )}
          </Field>
          <Button type="submit">Verify</Button>
        </Form>
      </StepCard>
    );
  else if (state === 'password_change') body = <PasswordStep onDone={refresh} />;
  else if (state === 'device_enroll') body = <DeviceStep onDone={refresh} />;
  else if (state === 'ready') body = <Dashboard />;
  else
    body = (
      <StepCard title={state === 'device_approval_required' ? 'Administrator approval needed' : 'Access unavailable'}>
        <Alert tone="amber">
          {state === 'device_approval_required'
            ? 'A new computer needs approval from the administrator. Please contact the administrator for assistance.'
            : state === 'device_unrecognized'
              ? 'This browser is not the registered device for this account. Please contact the administrator for assistance.'
              : 'This action is unavailable for your account. Please contact the administrator for assistance.'}
        </Alert>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={refresh}>
            Check again
          </Button>
          <Button variant="subtle" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </StepCard>
    );

  return <Shell email={email}>{body}</Shell>;
}
