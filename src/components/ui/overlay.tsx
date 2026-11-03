import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './core';

/* ------------------------------------------------- focus trap + scroll lock */
function useModal(open: boolean, onClose: () => void, panel: React.RefObject<HTMLElement>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const body = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => {
      const el = panel.current;
      const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el)?.focus();
    }, 20);
    function onKey(e: KeyboardEvent) {
      // Only the top-most modal reacts (e.g. a confirm dialog over a sheet).
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== panel.current) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = body;
      prev?.focus?.();
    };
  }, [open, panel]);
}
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* ---------------------------------------------------------------- Dialog */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'sm',
  role = 'dialog',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  role?: 'dialog' | 'alertdialog';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useModal(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="anim-fade absolute inset-0 bg-ink/30" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={description ? `${id}-d` : undefined}
        tabIndex={-1}
        className={cx(
          'anim-fade relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-surface shadow-pop outline-none sm:rounded-card',
          { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' }[size],
        )}
      >
        <div className="px-5 pb-2 pt-5 sm:px-6">
          <h2 id={`${id}-t`} className="text-[17px] font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <div id={`${id}-d`} className="mt-1.5 text-sm leading-relaxed text-muted">
              {description}
            </div>
          )}
        </div>
        {children && <div className="px-5 py-3 sm:px-6">{children}</div>}
        {footer && (
          <div className="flex flex-col-reverse gap-2 px-5 pb-5 pt-3 sm:flex-row sm:justify-end sm:px-6" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  tone = 'danger',
  busy,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      description={body}
      role="alertdialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/* ---------------------------------------------------------------- Sheet
   Side panel on tablet/desktop, full-screen on phones. */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useModal(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="anim-fade absolute inset-0 hidden bg-ink/25 sm:block" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        tabIndex={-1}
        className="anim-sheet relative flex h-full w-full flex-col bg-surface outline-none sm:max-w-[460px] sm:border-l sm:border-line sm:shadow-pop"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <div>
            <h2 id={`${id}-t`} className="text-[17px] font-semibold text-ink">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="-mr-2 grid h-10 w-10 place-items-center rounded-ctl text-muted hover:bg-ink-50 hover:text-ink" aria-label="Close">
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        <div className="flex gap-2 border-t border-line bg-surface px-5 py-3.5 sm:justify-end sm:px-6" style={{ paddingBottom: 'max(0.875rem, env(safe-area-inset-bottom))' }}>
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- Toasts */
type Toast = { id: number; text: string; tone: 'success' | 'error' | 'info' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-1), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 p-4 sm:bottom-0 sm:items-end sm:p-6">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="anim-toast pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-ctl bg-ink px-4 py-3 text-sm text-white shadow-pop"
          >
            <span
              className={cx('h-2 w-2 flex-none rounded-full', t.tone === 'success' && 'bg-[#5FC2B5]', t.tone === 'error' && 'bg-[#F39189]', t.tone === 'info' && 'bg-[#AEB6C6]')}
              aria-hidden="true"
            />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------- Menu */
export function Menu({ trigger, children, label }: { trigger: ReactNode; children: (close: () => void) => ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center gap-2 rounded-ctl px-2 text-left hover:bg-ink-50"
      >
        {trigger}
      </button>
      {open && (
        <div role="menu" className="anim-fade absolute right-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-card border border-line bg-surface py-1.5 shadow-pop">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, tone }: { onClick: () => void; children: ReactNode; tone?: 'danger' }) {
  return (
    <button role="menuitem" onClick={onClick} className={cx('block w-full px-3.5 py-2.5 text-left text-sm hover:bg-canvas', tone === 'danger' ? 'text-danger' : 'text-ink')}>
      {children}
    </button>
  );
}
