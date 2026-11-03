import { AppLink } from '../../components/AppLink';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { batchOverview, roster, todayISO } from '../../../supabase/functions/_shared/analytics.ts';
import { EmptyState, Input, Skeleton, StatCard } from '../../components/ui/core';
import { formatDateTime } from '../../lib/format';
import type { Batch } from './AdminApp';
import { PageHeader, SectionTitle } from './PageHeader';

export default function Overview({ batch }: { batch: Batch }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const today = todayISO();
  const d = batch.data;
  const o = useMemo(() => (d ? batchOverview(d.students, d.applications, today) : null), [d, today]);
  const rows = useMemo(() => (d ? roster(d.students, d.applications, today) : []), [d, today]);
  const filtered = rows.filter((r) => {
    const s = q.trim().toLowerCase();
    return !s || r.student.roll_number.toLowerCase().includes(s) || (r.student.name ?? '').toLowerCase().includes(s);
  });
  const loading = !d;

  return (
    <>
      <PageHeader title="Batch overview" subtitle="CL25M · M.Tech Clinical Engineering · placement season 2026–27" />
      {d?.namesHidden && (
        <p className="-mt-3 mb-6 text-sm text-muted">Student names are visible to the administrator only.</p>
      )}

      <p className="eyebrow mb-2">Students</p>
      <section aria-label="Student metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Registered students" value={o?.registeredStudents ?? 0} loading={loading} />
        <StatCard label="Profiles completed" value={o ? `${o.profilesCompleted}/${o.registeredStudents}` : 0} tone="teal" loading={loading} />
        <StatCard label="With ≥1 application" value={o?.studentsWithApplications ?? 0} tone="teal" loading={loading} />
        <StatCard label="No applications yet" value={o?.studentsWithoutApplications ?? 0} tone="muted" loading={loading} />
      </section>
      <p className="eyebrow mb-2 mt-6">Applications</p>
      <section aria-label="Application metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Application records" value={o?.totalApplications ?? 0} loading={loading} />
        <StatCard label="Unique companies" value={o?.uniqueCompanies ?? 0} loading={loading} />
        <StatCard label="Upcoming assessments" value={o?.upcomingAssessments ?? 0} tone="amber" loading={loading} hint="From today · excl. rejected/withdrawn" />
      </section>

      <SectionTitle hint={d ? `${filtered.length} of ${rows.length}` : undefined}>Student roster</SectionTitle>
      <div className="card overflow-hidden">
        <div className="border-b border-line p-3 sm:p-4">
          <label htmlFor="roster-search" className="sr-only">
            Search students
          </label>
          <Input id="roster-search" type="search" placeholder={d?.namesHidden ? 'Search by roll number' : 'Search by roll number or name'} value={q} onChange={(e) => setQ(e.target.value)} className="sm:max-w-xs" />
        </div>
        {loading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No matching students" body="Try a different roll number or name." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas/60 text-left text-xs font-medium text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium sm:px-5">Roll number</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Student name</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Applications</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Upcoming</th>
                  <th scope="col" className="px-4 py-2.5 font-medium sm:px-5">Last updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((r) => (
                  <tr
                    key={r.student.id}
                    className="cursor-pointer hover:bg-canvas/70 focus-within:bg-canvas/70"
                    onClick={() => nav(`/admin/students/${r.student.id}`)}
                  >
                    <td className="tnum px-4 py-3 font-medium sm:px-5">
                      <AppLink to={`/admin/students/${r.student.id}`} className="hover:underline">
                        {r.student.roll_number}
                      </AppLink>
                    </td>
                    <td className="px-4 py-3">
                      {d.namesHidden ? (
                        <span className="text-muted-light">Hidden</span>
                      ) : (
                        r.student.name ?? <span className="text-muted-light">Not set up yet</span>
                      )}
                    </td>
                    <td className="tnum px-4 py-3 text-right">{r.applications}</td>
                    <td className="tnum px-4 py-3 text-right">{r.upcoming ? <span className="font-medium text-amber">{r.upcoming}</span> : <span className="text-muted-light">0</span>}</td>
                    <td className="tnum px-4 py-3 text-muted sm:px-5">{formatDateTime(r.lastUpdated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
