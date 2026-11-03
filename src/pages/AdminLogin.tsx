import { AppLink } from '../components/AppLink';
import { Form } from '../components/Form';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button, Field, Input } from '../components/ui/core';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/supabase';

export default function AdminLogin() {
  const { adminSignIn, completeMfa, role, mfaPending, loading, signOut, adminSetupRequired, setupAdmin } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && (role === 'admin' || role === 'team') && !mfaPending) return <Navigate to="/admin" replace />;
  if (!loading && role === 'student') return <Navigate to="/app" replace />;

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if ((role === 'admin' || role === 'team') && mfaPending) {
    return (
      <AuthLayout>
        <p className="eyebrow">Administrator</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Two-step verification</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">Enter the 6-digit code from your authenticator app.</p>
        <Form
          noValidate
          className="mt-6 space-y-4"
          onSubmit={() => {
            if (!/^\d{6}$/.test(otp)) return setError('Enter the 6-digit code.');
            run(() => completeMfa(otp));
          }}
        >
          {error && <Alert>{error}</Alert>}
          <Field label="Authentication code">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                maxLength={6}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                className="tnum text-center text-lg tracking-[0.4em]"
                data-autofocus
              />
            )}
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Verify
          </Button>
          <Button variant="subtle" className="w-full" onClick={() => signOut()}>
            Use a different account
          </Button>
        </Form>
      </AuthLayout>
    );
  }

  if (adminSetupRequired) {
    return (
      <AuthLayout
        footer={
          <AppLink to="/login" className="hover:text-ink">
            ← Student sign in
          </AppLink>
        }
      >
        <p className="eyebrow">Administrator · first-time setup</p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">Create the administrator login</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">This is done once. Only this login can see batch analytics and exports.</p>
        <Form
          noValidate
          className="mt-6 space-y-4"
          onSubmit={() => {
            if (!email.includes('@')) return setError('Enter a valid email.');
            if (password.length < 10) return setError('Use a password of at least 10 characters.');
            if (password !== confirm) return setError('The two passwords do not match.');
            run(() => setupAdmin(email.trim(), password));
          }}
        >
          {error && <Alert>{error}</Alert>}
          <Field label="Email">
            {({ id }) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Password" hint="At least 10 characters.">
            {({ id, describedBy }) => (
              <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </Field>
          <Field label="Confirm password">
            {({ id }) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Create and sign in
          </Button>
        </Form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      footer={
        <AppLink to="/login" className="hover:text-ink">
          ← Student sign in
        </AppLink>
      }
    >
      <p className="eyebrow">Administrator</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">Placement coordination</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">For the administrator and approved placement coordinators.</p>
      <Form
        noValidate
        className="mt-6 space-y-4"
        onSubmit={() => {
          if (!email.includes('@') || !password) return setError('Enter your email and password.');
          run(() => adminSignIn(email.trim(), password));
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Field label="Email">
          {({ id }) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password">
          {({ id }) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </Form>
    </AuthLayout>
  );
}
