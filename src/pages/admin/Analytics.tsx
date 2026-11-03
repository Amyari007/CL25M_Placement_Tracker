import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import CompanyPie from '../../components/CompanyPie';
import { formatDateTime } from '../../lib/format';
import { companyGroups } from '../../../supabase/functions/_shared/analytics.ts';
import {
  STAGE_LABEL,
  companyMetrics,
  stageDistribution,
  todayISO,
  upcomingAssessments,
  type Stage,
} from '../../../supabase/functions/_shared/analytics.ts';
import { EmptyState, Skeleton, StageBadge, cx } from '../../components/ui/core';
import { formatDate, pct, relativeDay } from '../../lib/format';
import type { Batch } from './AdminApp';
import { PageHeader, SectionTitle } from './PageHeader';

const STAGE_COLOR: Record<Stage, string> = {
  applied: '#7C879B',
  assessment_scheduled: '#B45309',
  interview: '#34496F',
  offer_received: '#0F766E',
  rejected: '#B42318',
  withdrawn: '#B9B5AC',
};
const axisTick = { fill: '#5B6578', fontSize: 12 };

function ChartCard({ title, caption, children, className }: { title: string; caption?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx('card p-4 sm:p-5', className)} aria-label={title}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {caption && <p className="mt-0.5 text-xs text-muted">{caption}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TooltipBox({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-ctl border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="font-semibold text-ink">{title}</p>
      {lines.map((l) => (
        <p key={l} className="tnum mt-0.5 text-muted">
          {l}
        </p>
      ))}
    </div>
  );
}

export default function Analytics({ batch }: { batch: Batch }) {
  const d = batch.data;
  const today = todayISO();
  const metrics = useMemo(() => (d ? companyMetrics(d.applications) : []), [d]);
  const stages = useMemo(() => (d ? stageDistribution(d.applications) : []), [d]);
  const upcoming = useMemo(() => (d ? upcomingAssessments(d.students, d.applications, today) : []), [d, today]);
  const total = d?.applications.length ?? 0;
  const [open, setOpen] = useState<string | null>(null);
  const relTotal = metrics.reduce((n, m) => n + m.distinctStudents, 0);
  // Applicant identities per company group (staff-only page; data already
  // restricted to admin/team by the database).
  const applicants = useMemo(() => {
    if (!d) return new Map<string, { roll: string; name: string; company: string; stage: Stage; isDefault: boolean; test: string | null; updated: string }[]>();
    const groups = companyGroups(d.applications);
    const byId = new Map(d.students.map((x) => [x.id, x]));
    const out = new Map<string, { roll: string; name: string; company: string; stage: Stage; isDefault: boolean; test: string | null; updated: string }[]>();
    for (const a of d.applications) {
      const k = groups.get(a.id)!;
      const st = byId.get(a.student_id);
      const list = out.get(k) ?? [];
      list.push({ roll: st?.roll_number ?? '', name: st?.name ?? '', company: a.company_name, stage: a.application_stage, isDefault: a.stage_is_default, test: a.test_date, updated: a.updated_at });
      out.set(k, list);
    }
    for (const l of out.values()) l.sort((x, y) => x.roll.localeCompare(y.roll));
    return out;
  }, [d]);

  if (!d)
    return (
      <>
        <PageHeader title="Analytics" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </>
    );

  if (total === 0)
    return (
      <>
        <PageHeader title="Analytics" subtitle="Batch-wide application analytics" />
        <div className="card">
          <EmptyState title="No applications submitted yet" body="Charts will appear here as soon as students start recording applications." />
        </div>
      </>
    );

  const defaultApplied = stages.find((s) => s.stage === 'applied')?.defaultCount ?? 0;
  const barHeight = Math.max(160, metrics.length * 30 + 40);

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={
          <span className="tnum">
            {total} application records · {metrics.length} companies · {new Set(d.applications.map((a) => a.student_id)).size} students applying
          </span>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ChartCard title="How many students applied to each company?" caption={`Distinct students per company · out of ${relTotal} student–company applications`}>
          <CompanyPie rows={metrics.map((m) => ({ key: m.normalized, name: m.display, value: m.distinctStudents }))} total={relTotal} />
        </ChartCard>

        <ChartCard title="Students per company" caption="Distinct students per company, highest first">
          <div className="max-h-[360px] overflow-y-auto pr-1">
            <div style={{ height: barHeight }}>
              <ResponsiveContainer>
                <BarChart data={metrics} layout="vertical" margin={{ top: 0, right: 36, bottom: 0, left: 0 }} barCategoryGap={6}>
                  <CartesianGrid horizontal={false} stroke="#EEECE6" />
                  <XAxis type="number" allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="display" width={130} tick={axisTick} axisLine={false} tickLine={false} interval={0} />
                  <Tooltip
                    cursor={{ fill: '#F2F1EE' }}
                    content={({ active: a, payload }) => {
                      if (!a || !payload?.length) return null;
                      const m = payload[0].payload as (typeof metrics)[number];
                      return (
                        <TooltipBox
                          title={m.display}
                          lines={[`${m.applications} application records`, `${m.distinctStudents} distinct student${m.distinctStudents === 1 ? '' : 's'}`, `${pct(m.percentOfApplications)} of all records`]}
                        />
                      );
                    }}
                  />
                  <Bar dataKey="distinctStudents" fill="#13213C" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                    <LabelList dataKey="distinctStudents" position="right" style={{ fill: '#5B6578', fontSize: 12 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </ChartCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ChartCard
          title="Application stages"
          caption={defaultApplied ? `Includes ${defaultApplied} record${defaultApplied === 1 ? '' : 's'} where “Applied” is the stored default (stage not changed by the student).` : 'As recorded by students'}
        >
          <div style={{ height: 230 }}>
            <ResponsiveContainer>
              <BarChart data={stages} layout="vertical" margin={{ top: 0, right: 36, bottom: 0, left: 0 }} barCategoryGap={8}>
                <CartesianGrid horizontal={false} stroke="#EEECE6" />
                <XAxis type="number" allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="label" width={150} tick={axisTick} axisLine={false} tickLine={false} interval={0} />
                <Tooltip
                  cursor={{ fill: '#F2F1EE' }}
                  content={({ active: a, payload }) => {
                    if (!a || !payload?.length) return null;
                    const s = payload[0].payload as (typeof stages)[number];
                    const lines = [`${s.count} record${s.count === 1 ? '' : 's'} · ${pct(total ? (s.count / total) * 100 : 0)}`];
                    if (s.defaultCount) lines.push(`${s.defaultCount} set by default`);
                    return <TooltipBox title={STAGE_LABEL[s.stage]} lines={lines} />;
                  }}
                />
                <Bar dataKey="count" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                  {stages.map((s) => (
                    <Cell key={s.stage} fill={STAGE_COLOR[s.stage]} />
                  ))}
                  <LabelList dataKey="count" position="right" style={{ fill: '#5B6578', fontSize: 12 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="Upcoming assessments" caption="Across the batch, soonest first">
          {upcoming.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No upcoming assessments recorded.</p>
          ) : (
            <ul className="-mx-1 max-h-[250px] divide-y divide-line overflow-y-auto">
              {upcoming.map(({ application: a, student: s }) => (
                <li key={a.id} className="flex items-center gap-3 px-1 py-2.5">
                  <div className="w-[84px] flex-none">
                    <p className="tnum text-sm font-medium">{formatDate(a.test_date).replace(/ \d{4}$/, '')}</p>
                    <p className="text-2xs font-medium text-amber">{relativeDay(today, a.test_date!)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.company_name}</p>
                    <p className="tnum truncate text-xs text-muted">
                      {s?.roll_number}{d.namesHidden ? '' : ` · ${s?.name ?? 'Name not set'}`}
                    </p>
                  </div>
                  <StageBadge stage={a.application_stage} isDefault={a.stage_is_default} />
                </li>
              ))}
            </ul>
          )}
        </ChartCard>
      </div>

      <SectionTitle hint="Tap a company to see who applied · spellings are grouped">Company-wise applicants</SectionTitle>
      <div className="card overflow-hidden">
        <ul className="divide-y divide-line">
          {metrics.map((m) => {
            const isOpen = open === m.normalized;
            const people = applicants.get(m.normalized) ?? [];
            return (
              <li key={m.normalized}>
                <button
                  className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-canvas/70 sm:px-5"
                  aria-expanded={isOpen}
                  aria-controls={`app-${m.normalized}`}
                  onClick={() => setOpen(isOpen ? null : m.normalized)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{m.display}</span>
                    {m.spellings.length > 1 && (
                      <span className="mt-0.5 block truncate text-xs text-muted">Also entered as: {m.spellings.filter((x) => x !== m.display).join(', ')}</span>
                    )}
                  </span>
                  <span className="tnum whitespace-nowrap text-sm">
                    <span className="font-semibold">{m.distinctStudents}</span> <span className="text-muted">{m.distinctStudents === 1 ? 'student' : 'students'}</span>
                  </span>
                  <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-[#EEECE6] sm:block" aria-hidden="true">
                    <span className="block h-full rounded-full bg-teal" style={{ width: `${m.percentOfStudents}%` }} />
                  </span>
                  <span className="tnum w-12 text-right text-sm text-muted">{pct(m.percentOfStudents)}</span>
                  <svg viewBox="0 0 16 16" className={cx('h-4 w-4 flex-none text-muted transition-transform', isOpen && 'rotate-180')} aria-hidden="true">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {isOpen && (
                  <div id={`app-${m.normalized}`} className="border-t border-line bg-canvas/50 px-4 pb-3 pt-2 sm:px-5">
                    <p className="eyebrow mb-1.5 mt-1">{d.namesHidden ? 'Applicants by roll number · names visible to the administrator only' : 'Applicants · visible to administrator and approved team only'}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted">
                            <th scope="col" className="py-1.5 pr-3 font-medium">Roll number</th>
                            {!d.namesHidden && <th scope="col" className="py-1.5 pr-3 font-medium">Name</th>}
                            <th scope="col" className="py-1.5 pr-3 font-medium">Entered as</th>
                            <th scope="col" className="py-1.5 pr-3 font-medium">Stage</th>
                            <th scope="col" className="py-1.5 pr-3 font-medium">Test date</th>
                            <th scope="col" className="py-1.5 font-medium">Last submitted</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {people.map((p) => (
                            <tr key={`${p.roll}-${p.company}`}>
                              <td className="tnum py-2 pr-3 font-medium">{p.roll}</td>
                              {!d.namesHidden && <td className="py-2 pr-3">{p.name || <span className="text-muted-light">Not set</span>}</td>}
                              <td className="py-2 pr-3 text-muted">{p.company}</td>
                              <td className="py-2 pr-3">
                                <StageBadge stage={p.stage} isDefault={p.isDefault} />
                              </td>
                              <td className="tnum py-2 pr-3 text-muted">{p.test ? formatDate(p.test) : '—'}</td>
                              <td className="tnum py-2 text-muted">{formatDateTime(p.updated)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex justify-between border-t border-line-strong px-4 py-2.5 text-sm font-semibold sm:px-5">
          <span>Total student–company applications</span>
          <span className="tnum">{relTotal}</span>
        </div>
      </div>
    </>
  );
}
