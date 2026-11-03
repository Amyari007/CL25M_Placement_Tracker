import { AppNavLink } from '../../components/AppLink';
import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Alert, Button, Tag, Wordmark, cx } from '../../components/ui/core';
import { Menu, MenuItem, useToast } from '../../components/ui/overlay';
import { useAuth } from '../../lib/auth';
import { downloadExport, useBatchData } from '../../lib/adminApi';
import { friendlyError } from '../../lib/supabase';
import { formatDateTime } from '../../lib/format';
import Overview from './Overview';
import Analytics from './Analytics';
import StudentDetail from './StudentDetail';
import Settings from './Settings';
import Security from './Security';
import { IS_LOCAL } from '../../lib/mode';

const nav = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/analytics', label: 'Analytics' },
  ...(IS_LOCAL ? [] : [{ to: '/admin/security', label: 'Security' }]),
  { to: '/admin/settings', label: 'Settings' },
];

export default function AdminApp() {
  const { session, signOut, role } = useAuth();
  const isAdmin = role === 'admin';
  const toast = useToast();
  const batch = useBatchData();
  const [exporting, setExporting] = useState(false);

  async function exportData() {
    setExporting(true);
    try {
      const name = await downloadExport();
      toast(`Downloaded ${name}`);
    } catch (e) {
      toast(friendlyError(e), 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Wordmark />
            <Tag tone="teal">{isAdmin ? 'Admin' : 'Placement team'}</Tag>
          </div>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Administrator">
            {nav.map((n) => (
              <AppNavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  cx('rounded-md px-3 py-2 text-sm font-medium transition-colors', isActive ? 'bg-ink-50 text-ink' : 'text-muted hover:text-ink')
                }
              >
                {n.label}
              </AppNavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {isAdmin && (
            <Button
              size="sm"
              onClick={exportData}
              loading={exporting}
              icon={
                <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                  <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            >
              <span className="hidden sm:inline">Export data</span>
              <span className="sm:hidden">Export</span>
            </Button>
            )}
            <Menu
              label="Account menu"
              trigger={
                <span className="grid h-8 w-8 place-items-center rounded-full border border-line-strong text-xs font-semibold text-ink" aria-hidden="true">
                  {isAdmin ? 'AD' : 'PT'}
                </span>
              }
            >
              {(close) => (
                <>
                  <div className="border-b border-line px-3.5 pb-2.5 pt-1.5">
                    <p className="text-xs text-muted">Signed in as</p>
                    <p className="truncate text-sm font-medium">{session?.user.email}</p>
                  </div>
                  <MenuItem tone="danger" onClick={() => (close(), signOut())}>
                    Sign out
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto border-t border-line px-3 md:hidden" aria-label="Administrator">
          {nav.map((n) => (
            <AppNavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx('border-b-2 px-3 py-2.5 text-sm font-medium', isActive ? 'border-ink text-ink' : 'border-transparent text-muted')
              }
            >
              {n.label}
            </AppNavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-6">
        {batch.error && (
          <div className="mb-6 flex items-center justify-between gap-4">
            <Alert>{batch.error}</Alert>
            <Button variant="secondary" size="sm" onClick={batch.refresh}>
              Retry
            </Button>
          </div>
        )}
        <Routes>
          <Route index element={<Overview batch={batch} />} />
          <Route path="analytics" element={<Analytics batch={batch} />} />
          <Route path="students/:id" element={<StudentDetail batch={batch} />} />
          <Route path="settings" element={<Settings />} />
          {!IS_LOCAL && isAdmin && <Route path="security" element={<Security />} />}
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
        {batch.data && (
          <p className="mt-10 text-xs text-muted-light" aria-live="polite">
            Data as of {formatDateTime(batch.data.fetchedAt.toISOString())} IST{batch.refreshing ? ' · refreshing…' : ''} · updates automatically
          </p>
        )}
      </main>
    </div>
  );
}

export type Batch = ReturnType<typeof useBatchData>;
