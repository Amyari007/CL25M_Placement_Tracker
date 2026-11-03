import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { cx } from './ui/core';
import { pct } from '../lib/format';

export const PIE_PALETTE = ['#13213C', '#0F766E', '#4F6D8F', '#B45309', '#6E8B5A', '#7A4E6E', '#A68A5B', '#2F8FA1'];
const OTHER = '#C9CDD5';

export interface PieRow {
  key: string;
  name: string;
  /** Distinct students. */
  value: number;
}

/** Top N companies + "Other", so slices always add up to `total`. */
export function toSlices(rows: PieRow[], topN = 8): PieRow[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const top = sorted.slice(0, topN);
  const rest = sorted.slice(topN);
  if (rest.length) {
    top.push({ key: '__other__', name: `Other (${rest.length} ${rest.length === 1 ? 'company' : 'companies'})`, value: rest.reduce((n, r) => n + r.value, 0) });
  }
  return top;
}

/**
 * Donut + legend for "How many students applied to each company?".
 * Percentages use `total` = all distinct student–company relationships.
 */
export default function CompanyPie({
  rows,
  total,
  unit = 'applications',
  onSelect,
}: {
  rows: PieRow[];
  total: number;
  unit?: string;
  /** When given, a company in the chart or legend can be clicked. */
  onSelect?: (row: PieRow) => void;
}) {
  const pick = (s: PieRow) => onSelect && s.key !== '__other__' && onSelect(s);
  const slices = toSlices(rows);
  const [active, setActive] = useState<string | null>(null);
  const color = (s: PieRow, i: number) => (s.key === '__other__' ? OTHER : PIE_PALETTE[i % PIE_PALETTE.length]);
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
      <div className="relative h-[220px] w-[220px] flex-none" role="img" aria-label={`Pie chart of ${total} student applications across ${rows.length} companies`}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={66}
              outerRadius={104}
              paddingAngle={slices.length > 1 ? 1 : 0}
              stroke="#fff"
              strokeWidth={1.5}
              isAnimationActive={false}
              onMouseEnter={(_, i) => setActive(slices[i].key)}
              onMouseLeave={() => setActive(null)}
              onClick={(_, i) => pick(slices[i])}
            >
              {slices.map((s, i) => (
                <Cell key={s.key} fill={color(s, i)} opacity={active && active !== s.key ? 0.45 : 1} cursor={onSelect && s.key !== '__other__' ? 'pointer' : undefined} />
              ))}
            </Pie>
            <Tooltip
              content={({ active: a, payload }) => {
                if (!a || !payload?.length) return null;
                const p = payload[0].payload as PieRow;
                return (
                  <div className="rounded-ctl border border-line bg-surface px-3 py-2 text-xs shadow-pop">
                    <p className="font-semibold text-ink">{p.name}</p>
                    <p className="tnum mt-0.5 text-muted">
                      {p.value} {p.value === 1 ? 'student' : 'students'} · {pct((p.value / total) * 100)}
                    </p>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="tnum text-2xl font-semibold leading-none">{total}</p>
            <p className="mt-1 text-2xs uppercase tracking-wider text-muted">{unit}</p>
          </div>
        </div>
      </div>
      <table className="w-full min-w-0 flex-1 text-sm" aria-label="Students per company">
        <thead className="sr-only">
          <tr>
            <th>Company</th>
            <th>Students</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((s, i) => (
            <tr
              key={s.key}
              className={cx('rounded-md', active === s.key && 'bg-canvas')}
              onMouseEnter={() => setActive(s.key)}
              onMouseLeave={() => setActive(null)}
            >
              <td className="max-w-0 py-1 pl-1.5 pr-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: color(s, i) }} aria-hidden="true" />
                  {onSelect && s.key !== '__other__' ? (
                    <button type="button" onClick={() => pick(s)} className="truncate text-left hover:text-teal hover:underline">
                      {s.name}
                    </button>
                  ) : (
                    <span className="truncate">{s.name}</span>
                  )}
                </span>
              </td>
              <td className="tnum w-10 whitespace-nowrap py-1 text-right text-muted">{s.value}</td>
              <td className="tnum w-14 whitespace-nowrap py-1 pr-1.5 text-right text-muted-light">{pct((s.value / total) * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
