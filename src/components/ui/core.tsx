import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { STAGE_LABEL, type Stage } from '../../../supabase/functions/_shared/analytics.ts';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

/* ---------------------------------------------------------------- Button */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
const variants: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-ink-700 active:bg-ink-600 disabled:bg-ink/40',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-canvas hover:border-[#BFBBB1] disabled:text-muted-light',
  ghost: 'text-ink hover:bg-ink-50 disabled:text-muted-light',
  subtle: 'text-muted hover:text-ink hover:bg-ink-50 disabled:text-muted-light',
  danger: 'bg-danger text-white hover:bg-danger-700 disabled:bg-danger/40',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-ctl font-medium transition-colors disabled:cursor-not-allowed',
        size === 'md' ? 'h-11 px-4 text-[15px] sm:h-10 sm:text-sm' : 'h-9 px-3 text-sm sm:h-8 sm:text-[13px]',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('h-4 w-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------------------------------------- Fields */
interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}
export function Field({ label, hint, error, optional, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline justify-between text-sm font-medium text-ink">
        {label}
        {optional && <span className="text-xs font-normal text-muted-light">Optional</span>}
      </label>
      {children({ id, describedBy: [hintId, errId].filter(Boolean).join(' ') || undefined, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="flex items-center gap-1.5 text-xs font-medium text-danger" role="alert">
          <ErrorDot /> {error}
        </p>
      )}
    </div>
  );
}

function ErrorDot() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 flex-none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M8 4.5v4M8 11h.01" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx('ctl', className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...p },
  ref,
) {
  return <textarea ref={ref} className={cx('ctl py-2.5 leading-relaxed', className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...p }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cx('ctl appearance-none pr-9', className)} {...p} />
      <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

/* ---------------------------------------------------------------- Badges */
const stageStyle: Record<Stage, string> = {
  applied: 'bg-[#EEF0F4] text-[#3E4A60] ring-[#DCE0E8]',
  assessment_scheduled: 'bg-amber-50 text-amber ring-[#F3DDBE]',
  interview: 'bg-ink-50 text-ink-700 ring-[#D8DFEA]',
  offer_received: 'bg-teal-50 text-teal-700 ring-[#C7E2DE]',
  rejected: 'bg-danger-50 text-danger-700 ring-[#F4CFCB]',
  withdrawn: 'bg-[#F2F1EE] text-muted ring-line',
};
export function StageBadge({ stage, isDefault }: { stage: Stage; isDefault?: boolean }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', stageStyle[stage])}
      title={isDefault ? 'Default stage — not changed by the student' : undefined}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {STAGE_LABEL[stage]}
    </span>
  );
}

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'amber' | 'teal' | 'danger' }) {
  const t = {
    neutral: 'bg-[#F2F1EE] text-muted',
    amber: 'bg-amber-50 text-amber',
    teal: 'bg-teal-50 text-teal-700',
    danger: 'bg-danger-50 text-danger-700',
  }[tone];
  return <span className={cx('inline-flex items-center rounded-md px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide', t)}>{children}</span>;
}

/* ---------------------------------------------------------------- Cards */
export function StatCard({
  label,
  value,
  hint,
  tone = 'ink',
  loading,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: 'ink' | 'amber' | 'teal' | 'muted';
  loading?: boolean;
}) {
  const accent = { ink: 'bg-ink', amber: 'bg-amber', teal: 'bg-teal', muted: 'bg-muted-light' }[tone];
  return (
    <div className="card relative overflow-hidden px-4 py-4 sm:px-5">
      <span className={cx('absolute left-0 top-4 h-5 w-[3px] rounded-r', accent)} aria-hidden="true" />
      <p className="text-[13px] font-medium text-muted">{label}</p>
      {loading ? (
        <div className="skeleton mt-2 h-7 w-12" />
      ) : (
        <p className="tnum mt-1.5 text-[26px] font-semibold leading-none tracking-tight text-ink">{value}</p>
      )}
      {hint && <p className="mt-2 text-xs text-muted-light">{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-5 grid h-11 w-11 place-items-center rounded-full border border-line bg-canvas" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <path d="M4 10h16M9 3v4M15 3v4" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

export function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-7 w-7 flex-none" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#13213C" />
        <path d="M9 21.5V10.5h3.2l3.8 6.2 3.8-6.2H23v11h-2.9v-6.4l-3.2 5.1h-1.8l-3.2-5.1v6.4z" fill="#F7F6F3" />
      </svg>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight text-ink">CL25M</span>
        {!compact && <span className="block text-2xs font-medium uppercase tracking-[0.12em] text-muted">Placement Tracker</span>}
      </span>
    </span>
  );
}

export function Alert({ tone = 'danger', children }: { tone?: 'danger' | 'amber' | 'teal' | 'neutral'; children: ReactNode }) {
  const t = {
    danger: 'border-[#F4CFCB] bg-danger-50 text-danger-700',
    amber: 'border-[#F3DDBE] bg-amber-50 text-[#8A3F07]',
    teal: 'border-[#C7E2DE] bg-teal-50 text-teal-700',
    neutral: 'border-line bg-canvas text-muted',
  }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('rounded-ctl border px-3.5 py-2.5 text-sm leading-relaxed', t)}>
      {children}
    </div>
  );
}
