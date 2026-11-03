import { AppLink } from './AppLink';
import type { ReactNode } from 'react';
import { Wordmark } from './ui/core';
import { IS_LOCAL } from '../lib/mode';

export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[340px]"
        style={{ background: 'linear-gradient(180deg, #EEF1F6 0%, rgba(247,246,243,0) 100%)' }}
        aria-hidden="true"
      />
      <main className="relative flex flex-1 items-start justify-center px-4 pt-[10vh] sm:items-center sm:pt-0">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex justify-center">
            <Wordmark />
          </div>
          <div className="card px-6 py-7 sm:px-8 sm:py-8">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
        </div>
      </main>
      <footer className="relative px-4 py-6 text-center text-xs text-muted-light">
        {IS_LOCAL && <span className="mb-1 block">Offline version · data stays in this browser</span>}
        M.Tech Clinical Engineering · IIT Madras ·{' '}
        <AppLink to="/privacy" className="underline decoration-line-strong underline-offset-2 hover:text-ink">
          Privacy notice
        </AppLink>
      </footer>
    </div>
  );
}
