import { Form } from '../../components/Form';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isUpcoming, sameCompany, studentSummary, todayISO } from '../../../supabase/functions/_shared/analytics.ts';
import { StudentHeader } from '../../components/StudentHeader';
import { ApplicationForm } from '../../components/ApplicationForm';
import { Alert, Button, EmptyState, Input, Skeleton, StageBadge, StatCard, Tag, cx } from '../../components/ui/core';
import { ConfirmDialog, useToast } from '../../components/ui/overlay';
import { useAuth } from '../../lib/auth';
import { fetchCompanyStats, listMyApplications, submitApplications, type StatsResult } from '../../lib/studentApi';
import { friendlyError } from '../../lib/errors';
import { firstName, formatDate, greeting, relativeDay } from '../../lib/format';
import type { ApplicationDraft, ApplicationRow } from '../../lib/types';

const CompanyPie = lazy(() => import('../../components/CompanyPie'));

/* ------------------------------------------------------------------ draft */
type Status = 'saved' | 'new' | 'edited' | 'removed';
interface Item {
  localId: string;
  serverId?: string;
  data: ApplicationDraft;
  removed?: boolean;
}

const toDraft = (a: ApplicationRow): ApplicationDraft => ({
  company_name: a.company_name,
  test_date: a.test_date ?? '',
  role: a.role ?? '',
  application_stage: a.application_stage,
  stage_is_default: a.stage_is_default,
  notes: a.notes ?? '',
});
const fromServer = (rows: ApplicationRow[]): Item[] => rows.map((a) => ({ localId: a.id, serverId: a.id, data: toDraft(a) }));
const sameData = (x: ApplicationDraft, y: ApplicationDraft) =>
  x.company_name.trim() === y.company_name.trim() &&
  (x.test_date || '') === (y.test_date || '') &&
  x.role.trim() === y.role.trim() &&
  x.application_stage === y.application_stage &&
  x.stage_is_default === y.stage_is_default &&
  x.notes.trim() === y.notes.trim();

function statusOf(it: Item, server: Map<string, ApplicationRow>): Status {
  if (it.removed) return 'removed';
  const s = it.serverId ? server.get(it.serverId) : undefined;
  if (!s) return 'new';
  return sameData(it.data, toDraft(s)) ? 'saved' : 'edited';
}

const draftKey = (studentId: string) => `cl25m-draft-v1-${studentId}`;
function readDraft(studentId: string): Item[] | null {
  try {
    const raw = localStorage.getItem(draftKey(studentId));
    return raw ? (JSON.parse(raw) as Item[]) : null;
  } catch {
    return null;
  }
}
function writeDraft(studentId: string, items: Item[] | null) {
  try {
    if (items) localStorage.setItem(draftKey(studentId), JSON.stringify(items));
    else localStorage.removeItem(draftKey(studentId));
  } catch {
    /* storage unavailable: draft lives in memory only */
  }
}

/** Restores an unsent draft on top of what the server has now. */
function reconcile(draft: Item[], rows: ApplicationRow[]): Item[] {
  const ids = new Set(rows.map((r) => r.id));
  const out = draft.map((it) => (it.serverId && !ids.has(it.serverId) ? { ...it, serverId: undefined, removed: false } : it)).filter((it) => it.serverId || !it.removed);
  const inDraft = new Set(out.map((i) => i.serverId).filter(Boolean));
  for (const r of rows) if (!inDraft.has(r.id)) out.push({ localId: r.id, serverId: r.id, data: toDraft(r) });
  return out;
}

const newId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const STATUS_TAG: Record<Exclude<Status, 'saved'>, { label: string; tone: 'teal' | 'amber' | 'danger' }> = {
  new: { label: 'New · not submitted', tone: 'teal' },
  edited: { label: 'Edited · not submitted', tone: 'amber' },
  removed: { label: 'Will be removed', tone: 'danger' },
};

/* ------------------------------------------------------------------ page */
export default function StudentDashboard() {
  const { student, refresh: refreshAuth } = useAuth();
  const toast = useToast();
  const today = todayISO();
  const sid = student!.id;

  const [server, setServer] = useState<ApplicationRow[] | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const [stats, setStats] = useState<StatsResult | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const hasSubmitted = !!student?.submitted_at || (server?.length ?? 0) > 0;

  const serverMap = useMemo(() => new Map((server ?? []).map((r) => [r.id, r])), [server]);
  const withStatus = useMemo(() => items.map((it) => ({ it, status: statusOf(it, serverMap) })), [items, serverMap]);
  const pending = withStatus.filter((x) => x.status !== 'saved');
  const dirty = pending.length > 0;
  const ready = withStatus.filter((x) => x.status !== 'removed').length;

  /* ---- load saved list (+ restore unsent draft) */
  const loadList = useCallback(async () => {
    setLoadErr(null);
    try {
      const rows = await listMyApplications();
      setServer(rows);
      const draft = readDraft(sid);
      setItems(draft ? reconcile(draft, rows) : fromServer(rows));
    } catch (e) {
      setLoadErr(friendlyError(e));
    }
  }, [sid]);

  /* ---- batch statistics: fresh on every visit, after submit, and every 30 s */
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await fetchCompanyStats());
      setStatsErr(null);
    } catch (e) {
      setStatsErr(friendlyError(e));
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!hasSubmitted) return;
    loadStats();
    const onVis = () => document.visibilityState === 'visible' && loadStats();
    document.addEventListener('visibilitychange', onVis);
    const iv = setInterval(() => document.visibilityState === 'visible' && loadStats(), 30_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(iv);
    };
  }, [hasSubmitted, loadStats]);

  /* ---- keep unsent work safe across refreshes */
  useEffect(() => {
    if (!server) return;
    writeDraft(sid, dirty ? items : null);
  }, [items, dirty, server, sid]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  /* ---- editing the draft */
  function clash(name: string, exceptId?: string): Item | undefined {
    return items.find((it) => it.localId !== exceptId && sameCompany(it.data.company_name, name));
  }

  function add() {
    const name = newName.trim().replace(/\s+/g, ' ');
    if (!name) return setAddErr('Type a company name first.');
    if (name.length > 120) return setAddErr('Use 120 characters or fewer.');
    const dup = clash(name);
    if (dup && !dup.removed) return setAddErr(`Already in your list as “${dup.data.company_name}”.`);
    if (dup?.removed) {
      setItems((xs) => xs.map((x) => (x.localId === dup.localId ? { ...x, removed: false } : x)));
      toast(`${dup.data.company_name} restored`, 'info');
    } else {
      setItems((xs) => [
        ...xs,
        { localId: newId(), data: { company_name: name, test_date: '', role: '', application_stage: 'applied', stage_is_default: true, notes: '' } },
      ]);
    }
    setNewName('');
    setAddErr(null);
    setSubmitErr(null);
  }

  function remove(it: Item) {
    setSubmitErr(null);
    if (!it.serverId) setItems((xs) => xs.filter((x) => x.localId !== it.localId));
    else setItems((xs) => xs.map((x) => (x.localId === it.localId ? { ...x, removed: true } : x)));
  }
  function undo(it: Item) {
    const s = it.serverId ? serverMap.get(it.serverId) : undefined;
    setItems((xs) => xs.map((x) => (x.localId === it.localId ? { ...x, removed: false, data: s ? toDraft(s) : x.data } : x)));
  }
  function discardAll() {
    setItems(fromServer(server ?? []));
    setSubmitErr(null);
    setConfirmDiscard(false);
  }

  /* ---- Submit Applications */
  async function submit() {
    if (submittingRef.current) return; // no double submissions
    const list = items.filter((x) => !x.removed);
    if (!list.length && !hasSubmitted) return setSubmitErr('Add at least one company before submitting.');
    for (let i = 0; i < list.length; i++) {
      const dup = list.slice(0, i).find((p) => sameCompany(p.data.company_name, list[i].data.company_name));
      if (dup) return setSubmitErr(`“${dup.data.company_name}” and “${list[i].data.company_name}” look like the same company — keep one.`);
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const rows = await submitApplications(list.map((x) => x.data));
      // Only reached when the database confirmed the save.
      setServer(rows);
      setItems(fromServer(rows));
      writeDraft(sid, null);
      toast(rows.length ? `Submitted — ${rows.length} ${rows.length === 1 ? 'company' : 'companies'} saved` : 'Submitted — your list is now empty');
      await refreshAuth(); // picks up submitted_at
      await loadStats();
    } catch (e) {
      setSubmitErr(`Not submitted. ${friendlyError(e)} Your list is still here.`);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const summary = useMemo(() => studentSummary(server ?? [], today), [server, today]);
  const loading = server === null && !loadErr;
  const sorted = useMemo(
    () =>
      [...withStatus].sort((a, b) => {
        const rank = (x: (typeof withStatus)[number]) => (x.status === 'removed' ? 2 : x.status === 'new' ? 0 : 1);
        return rank(a) - rank(b) || a.it.data.company_name.localeCompare(b.it.data.company_name);
      }),
    [withStatus],
  );

  return (
    <div className="min-h-screen">
      <StudentHeader />
      <main className="mx-auto max-w-5xl px-4 pb-40 pt-8 sm:px-6 sm:pt-10">
        {/* 1. Welcome */}
        <section aria-labelledby="welcome">
          <h1 id="welcome" className="text-[26px] font-semibold tracking-tight text-ink sm:text-[28px]">
            {greeting()}, {firstName(student?.name)}.
          </h1>
          <p className="mt-1.5 text-[15px] text-muted">Keep your placement journey organized, one application at a time.</p>
        </section>

        <section aria-label="Summary of submitted applications" className="mt-7 grid grid-cols-3 gap-2.5 sm:gap-4">
          <StatCard label="Submitted companies" value={summary.total} loading={loading} />
          <StatCard label="Upcoming assessments" value={summary.upcoming} tone="amber" loading={loading} />
          <StatCard label="No test date yet" value={summary.noTestDate} tone="muted" loading={loading} />
        </section>

        {/* 2–4. Companies I've Applied To + entry + submit */}
        <section aria-labelledby="apps-h" className="mt-10">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <h2 id="apps-h" className="text-lg font-semibold tracking-tight">
              Companies I've Applied To
            </h2>
            {server && (
              <p className="text-sm text-muted" aria-live="polite">
                {dirty ? (
                  <span className="font-medium text-amber">
                    {pending.length} unsaved {pending.length === 1 ? 'change' : 'changes'}
                  </span>
                ) : hasSubmitted ? (
                  <span className="text-teal-700">All changes submitted</span>
                ) : (
                  'Nothing submitted yet'
                )}
              </p>
            )}
          </div>

          {loadErr && (
            <div className="space-y-3">
              <Alert>{loadErr}</Alert>
              <Button variant="secondary" onClick={loadList}>
                Try again
              </Button>
            </div>
          )}

          {loading && (
            <div className="card space-y-3 p-5" aria-busy="true" aria-label="Loading your companies">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          )}

          {server && (
            <div className="card">
              <Form onSubmit={() => add()} className="border-b border-line p-3 sm:p-4" noValidate>
                <label htmlFor="add-company" className="sr-only">
                  Company name
                </label>
                <div className="flex gap-2">
                  <Input
                    id="add-company"
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      if (addErr) setAddErr(null);
                    }}
                    placeholder="Add a company, e.g. Philips"
                    autoComplete="off"
                    enterKeyHint="done"
                    aria-invalid={!!addErr}
                    aria-describedby={addErr ? 'add-err' : undefined}
                  />
                  <Button type="submit" variant="secondary" className="flex-none">
                    Add
                  </Button>
                </div>
                {addErr && (
                  <p id="add-err" role="alert" className="mt-1.5 text-xs font-medium text-danger">
                    {addErr}
                  </p>
                )}
              </Form>

              {items.length === 0 ? (
                <EmptyState title="Your placement tracker starts here." body="Add the companies you've applied to, then press Submit Applications to save them." />
              ) : (
                <ul className="divide-y divide-line">
                  {sorted.map(({ it, status }) => {
                    const d = it.data;
                    const up = d.test_date && isUpcoming({ test_date: d.test_date, application_stage: d.application_stage }, today);
                    return (
                      <li key={it.localId} className={cx('px-4 py-3.5 sm:px-5', status === 'removed' && 'bg-canvas/60')}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className={cx('truncate text-[15px] font-semibold', status === 'removed' ? 'text-muted line-through' : 'text-ink')}>{d.company_name}</p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                              {d.test_date ? (
                                <span className="tnum">
                                  {formatDate(d.test_date)}
                                  {up && <span className="ml-1.5 text-xs font-medium text-amber">{relativeDay(today, d.test_date)}</span>}
                                </span>
                              ) : (
                                <span className="text-muted-light">No test date</span>
                              )}
                              {d.role && <span className="truncate">· {d.role}</span>}
                            </p>
                            {status !== 'saved' && (
                              <div className="mt-1.5">
                                <Tag tone={STATUS_TAG[status].tone}>{STATUS_TAG[status].label}</Tag>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-none flex-col items-end gap-1.5">
                            {status !== 'removed' && <StageBadge stage={d.application_stage} />}
                            <div className="-mr-2 flex">
                              {status === 'removed' ? (
                                <Button variant="subtle" size="sm" onClick={() => undo(it)} aria-label={`Undo removing ${d.company_name}`}>
                                  Undo
                                </Button>
                              ) : (
                                <>
                                  <Button variant="subtle" size="sm" onClick={() => setEditing(it)} aria-label={`Edit ${d.company_name}`}>
                                    Edit
                                  </Button>
                                  <Button variant="subtle" size="sm" onClick={() => remove(it)} aria-label={`Remove ${d.company_name}`}>
                                    Remove
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {submitErr && (
            <div className="mt-3">
              <Alert>{submitErr}</Alert>
            </div>
          )}

          {/* Desktop submit row */}
          {server && (
            <div className="mt-4 hidden items-center justify-between gap-4 sm:flex">
              <p className="text-sm text-muted">
                <span className="tnum font-medium text-ink">{ready}</span> {ready === 1 ? 'company' : 'companies'} ready to submit
                {dirty && (
                  <>
                    {' · '}
                    <button className="underline decoration-line-strong underline-offset-2 hover:text-ink" onClick={() => setConfirmDiscard(true)}>
                      Discard changes
                    </button>
                  </>
                )}
              </p>
              <Button onClick={submit} loading={submitting} disabled={!dirty && hasSubmitted} className="min-w-[200px]">
                {submitting ? 'Submitting…' : 'Submit Applications'}
              </Button>
            </div>
          )}
        </section>

        {/* 5–6. Batch-wide chart + last updated */}
        <section aria-labelledby="stats-h" className="mt-12">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="stats-h" className="text-lg font-semibold tracking-tight">
                How many students applied to each company?
              </h2>
              <p className="text-sm text-muted">Across the CL25M batch · counts only, no names</p>
            </div>
            {hasSubmitted && (
              <Button variant="subtle" size="sm" onClick={loadStats} loading={statsLoading} aria-label="Refresh statistics">
                Refresh
              </Button>
            )}
          </div>
          <div className="card p-4 sm:p-5">
            {!hasSubmitted ? (
              <EmptyState
                title="Submit your applications to see the batch picture"
                body="Once you've submitted your list, you'll see how many students have applied to each company. Only totals are shown — never who applied."
              />
            ) : !stats && !statsErr ? (
              <div className="flex items-center gap-6" aria-busy="true" aria-label="Loading statistics">
                <Skeleton className="h-[180px] w-[180px] rounded-full" />
                <div className="flex-1 space-y-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </div>
            ) : (
              <>
                {statsErr && (
                  <div className="mb-4">
                    <Alert tone="amber">
                      Couldn't refresh the statistics. {stats ? `The figures below are from ${stats.refreshedAt.toLocaleTimeString('en-IN')} and may be out of date.` : ''}{' '}
                      <button className="font-medium underline" onClick={loadStats}>
                        Try again
                      </button>
                    </Alert>
                  </div>
                )}
                {stats && stats.total === 0 && <p className="py-8 text-center text-sm text-muted">No applications have been submitted across the batch yet.</p>}
                {stats && stats.total > 0 && (
                  <div className={cx(statsErr && 'opacity-60')}>
                    <Suspense fallback={<Skeleton className="h-[220px] w-full" />}>
                      <CompanyPie rows={stats.rows.map((r) => ({ key: r.company, name: r.company, value: r.students }))} total={stats.total} />
                    </Suspense>
                    <p className="mt-4 text-xs leading-relaxed text-muted-light">
                      Each student counts once per company. Percentages are out of {stats.total} student–company applications in total. Different spellings of a company are grouped.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
          {stats && (
            <p className="mt-2 text-xs text-muted-light" aria-live="polite">
              Last updated {stats.refreshedAt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' })}
              {statsErr ? ' · refresh failed' : ' · refreshes automatically'}
            </p>
          )}
        </section>
      </main>

      {/* Mobile submit bar */}
      {server && (
        <div
          className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-canvas/95 px-4 pt-2.5 backdrop-blur sm:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>
              <span className="tnum font-semibold text-ink">{ready}</span> ready to submit
            </span>
            {dirty ? (
              <button className="underline underline-offset-2" onClick={() => setConfirmDiscard(true)}>
                Discard changes
              </button>
            ) : (
              hasSubmitted && <span className="text-teal-700">All changes submitted</span>
            )}
          </div>
          <Button onClick={submit} loading={submitting} disabled={!dirty && hasSubmitted} className="w-full">
            {submitting ? 'Submitting…' : 'Submit Applications'}
          </Button>
        </div>
      )}

      <ApplicationForm
        open={!!editing}
        editing={
          editing
            ? ({
                id: editing.localId,
                student_id: sid,
                company_name: editing.data.company_name,
                normalized_company_name: '',
                role: editing.data.role || null,
                application_stage: editing.data.application_stage,
                stage_is_default: editing.data.stage_is_default,
                test_date: editing.data.test_date || null,
                notes: editing.data.notes || null,
                created_at: '',
                updated_at: '',
              } as ApplicationRow)
            : null
        }
        saveLabel="Update entry"
        footnote="Changes are saved when you press Submit Applications."
        validateCompany={(name) => {
          const dup = clash(name, editing?.localId);
          return dup ? `Already in your list as “${dup.data.company_name}”.` : null;
        }}
        onClose={() => setEditing(null)}
        onSave={async (d) => {
          const id = editing!.localId;
          setItems((xs) => xs.map((x) => (x.localId === id ? { ...x, data: { ...d, company_name: d.company_name.trim().replace(/\s+/g, ' ') } } : x)));
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        body="Your list goes back to what you last submitted."
        confirmLabel="Discard changes"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={discardAll}
      />
    </div>
  );
}
