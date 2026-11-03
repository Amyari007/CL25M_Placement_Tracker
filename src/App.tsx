import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ROUTER_MODE } from './lib/routerMode';
import { AuthProvider, useAuth } from './lib/auth';
import { isConfigured } from './lib/supabase';
import { IS_LOCAL } from './lib/mode';
import { ToastProvider } from './components/ui/overlay';
import { Spinner, Wordmark } from './components/ui/core';
import StudentLogin from './pages/StudentLogin';
import AdminLogin from './pages/AdminLogin';
import Onboarding from './pages/student/Onboarding';
import StudentDashboard from './pages/student/Dashboard';
import Privacy from './pages/Privacy';

// The admin workspace (and the chart library) only loads after admin sign-in.
const AdminApp = lazy(() => import('./pages/admin/AdminApp'));
const CoordinatorApp = lazy(() => import('./pages/coordinator/CoordinatorApp'));

function FullPageLoader() {
  return (
    <div className="grid min-h-screen place-items-center" role="status" aria-label="Loading">
      <div className="flex flex-col items-center gap-4 text-muted">
        <Wordmark compact />
        <Spinner />
      </div>
    </div>
  );
}

function Home() {
  const { loading, role, student, mfaPending } = useAuth();
  if (loading) return <FullPageLoader />;
  if (role === 'student') return <Navigate to={student?.name ? '/app' : '/welcome'} replace />;
  if (role === 'admin' || role === 'team') return <Navigate to={mfaPending ? '/admin/login' : '/admin'} replace />;
  return <Navigate to="/login" replace />;
}

function RequireStudent({ children, onboarding }: { children: ReactNode; onboarding?: boolean }) {
  const { loading, role, student } = useAuth();
  const loc = useLocation();
  if (loading) return <FullPageLoader />;
  if (role !== 'student' || !student) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!onboarding && !student.name) return <Navigate to="/welcome" replace />;
  if (onboarding && student.name) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { loading, role, mfaPending } = useAuth();
  if (loading) return <FullPageLoader />;
  if ((role !== 'admin' && role !== 'team') || mfaPending) return <Navigate to="/admin/login" replace />;
  return <>{children}</>;
}

// Coordinators get their own restricted portal (online version).
function AdminArea() {
  const { role } = useAuth();
  return role === 'team' && !IS_LOCAL ? <CoordinatorApp /> : <AdminApp />;
}

function NotConfigured() {
  return (
    <div className="mx-auto max-w-lg px-6 py-20">
      <Wordmark />
      <h1 className="mt-8 text-xl font-semibold">Backend not configured</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Set <code className="rounded bg-ink-50 px-1">VITE_SUPABASE_URL</code> and <code className="rounded bg-ink-50 px-1">VITE_SUPABASE_ANON_KEY</code> (see
        README) and rebuild. The app will not run without its database.
      </p>
    </div>
  );
}

export default function App() {
  if (!isConfigured) return <NotConfigured />;
  // Hosted build: normal paths. Single file opened from disk: hash URLs.
  // Preview panels (about:srcdoc, blob:) have no usable address, so routing
  // stays in memory there — otherwise building links throws "Invalid URL".
  const Router = ROUTER_MODE === 'browser' ? BrowserRouter : ROUTER_MODE === 'hash' ? HashRouter : MemoryRouter;
  return (
    <Router>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<StudentLogin />} />
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route
              path="/welcome"
              element={
                <RequireStudent onboarding>
                  <Onboarding />
                </RequireStudent>
              }
            />
            <Route
              path="/app"
              element={
                <RequireStudent>
                  <StudentDashboard />
                </RequireStudent>
              }
            />
            <Route
              path="/admin/*"
              element={
                <RequireAdmin>
                  <Suspense fallback={<FullPageLoader />}>
                    <AdminArea />
                  </Suspense>
                </RequireAdmin>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </Router>
  );
}
