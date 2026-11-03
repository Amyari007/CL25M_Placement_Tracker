import { AppLink } from '../components/AppLink';
import { Form } from '../components/Form';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { AuthLayout } from '../components/AuthLayout';
import { Alert, Button, Field, Input } from '../components/ui/core';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/supabase';

export default function StudentLogin() {
  const { studentSignIn, role, loading } = useAuth();
  const [roll, setRoll] = useState('CL25M');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ roll?: string; code?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  if (!loading && role === 'student') return <Navigate to="/" replace />;

  async function submit() {
    if (busy) return;
    const r = roll.trim().toUpperCase();
    const next: typeof errors = {};
    if (!/^CL25M\d{3}$/.test(r)) next.roll = 'Enter your full roll number, e.g. CL25M001.';
    if (!/^\d{4,12}$/.test(code.trim())) next.code = 'Enter your numeric access code.';
    setErrors(next);
    if (next.roll || next.code) return;
    setBusy(true);
    try {
      await studentSignIn(r, code.trim());
    } catch (err) {
      setErrors({ form: err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.' });
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      footer={
        <AppLink to="/admin/login" className="hover:text-ink">
          Administrator sign in →
        </AppLink>
      }
    >
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">Your placement journey, organized.</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">A private workspace for your placement applications.</p>

      <Form onSubmit={() => submit()} noValidate className="mt-7 space-y-4">
        {errors.form && <Alert>{errors.form}</Alert>}
        <Field label="Roll number" error={errors.roll}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={roll}
              onChange={(e) => setRoll(e.target.value.toUpperCase())}
              autoComplete="username"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="CL25M001"
              maxLength={8}
              className="tnum tracking-wide"
            />
          )}
        </Field>
        <Field label="Access code" error={errors.code}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              maxLength={12}
              className="tnum tracking-[0.3em]"
            />
          )}
        </Field>
        <Button type="submit" className="mt-2 w-full" loading={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </Form>
      <p className="mt-5 text-xs leading-relaxed text-muted-light">Forgot your code? Ask the batch placement coordinator to reset it.</p>
    </AuthLayout>
  );
}
