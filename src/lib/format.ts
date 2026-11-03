import { APP_TIMEZONE } from '../../supabase/functions/_shared/analytics.ts';

export function formatDate(ymd: string | null | undefined, opts: { weekday?: boolean } = {}): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    weekday: opts.weekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: APP_TIMEZONE,
  }).format(new Date(iso));
}

/** Whole days from today to ymd (both in YYYY-MM-DD). */
export function daysFrom(today: string, ymd: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function relativeDay(today: string, ymd: string): string {
  const n = daysFrom(today, ymd);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n <= 30) return `In ${n} days`;
  if (n < -1) return 'Past';
  return '';
}

export function greeting(now = new Date()): string {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: APP_TIMEZONE }).format(now));
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

export function pct(n: number): string {
  return `${n.toFixed(n >= 10 || n === 0 ? 0 : 1)}%`;
}
