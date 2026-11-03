import { AppLink } from '../../components/AppLink';
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { isUpcoming, studentSummary, todayISO } from '../../../supabase/functions/_shared/analytics.ts';
import { EmptyState, Skeleton, StageBadge, StatCard, Tag, cx } from '../../components/ui/core';
import { formatDate, formatDateTime, relativeDay } from '../../lib/format';
import type { Batch } from './AdminApp';
import { PageHeader } from './PageHeader';

export default function StudentDetail({ batch }: { batch: Batch }) {
  const { id } = useParams();
  const today = todayISO();
  const d = batch.data;
  const student = d?.students.find((s) => s.id === id);
  const apps = useMemo(
    () =>
      (d?.applications ?? [])
        .filter((a) => a.student_id === id)
        .sort((a, b) => (a.test_date ?? '9999').localeCompare(b.test_date ?? '9999') || a.company_name.localeCompare(b.company_name)),
    [d, id],
  );
  const s = studentSummary(apps, today);

  if (!d) return <Skeleton className="h-40 w-full" />;
  if (!student)
    return (
      <div className="card">
        <EmptyState title="Student not found" body="This record does not exist." action={<AppLink to="/admin" className="text-sm text-teal hover:underline">Back to overview</AppLink>} />
      </div>
    );

  return (
    <>
      <AppLink to="/admin" className="mb-4 inline-block text-sm text-muted hover:text-ink">
        ← Overview
      </AppLink>
      <PageHeader
        title={d.namesHidden ? student.roll_number : student.name ?? 'Profile not set up'}
        subtitle={
          <span className="flex items-center gap-2">
            <span className="tnum">{student.roll_number}</span>
            <span aria-hidden="true">·</span> Last updated {formatDateTime(student.last_activity_at)}
            <Tag>Read-only</Tag>
          </span>
        }
      />
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Applications" value={s.total} />
        <StatCard label="Upcoming" value={s.upcoming} tone="amber" />
        <StatCard label="No test date" value={s.noTestDate} tone="muted" />
      </div>
      <div className="card mt-6 overflow-hidden">
        {apps.length === 0 ? (
          <EmptyState title="No applications recorded" body="This student has not added any applications yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas/60 text-left text-xs text-muted">
                  <th scope="col" className="px-5 py-2.5 font-medium">Company</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Test date</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Stage</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {apps.map((a) => {
                  const up = isUpcoming(a, today);
                  return (
                    <tr key={a.id}>
                      <td className="px-5 py-3 font-medium">{a.company_name}</td>
                      <td className="px-4 py-3 text-muted">{a.role ?? '—'}</td>
                      <td className="tnum px-4 py-3">
                        {a.test_date ? (
                          <>
                            <span className={cx(!up && 'text-muted')}>{formatDate(a.test_date)}</span>
                            {up && <span className="ml-2 text-xs font-medium text-amber">{relativeDay(today, a.test_date)}</span>}
                          </>
                        ) : (
                          <span className="text-muted-light">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StageBadge stage={a.application_stage} isDefault={a.stage_is_default} />
                        {a.stage_is_default && <span className="ml-1.5 text-2xs text-muted-light">default</span>}
                      </td>
                      <td className="max-w-xs whitespace-pre-wrap break-words px-5 py-3 text-muted">{a.notes ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
