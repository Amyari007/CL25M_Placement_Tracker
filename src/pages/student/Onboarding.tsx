import { Form } from '../../components/Form';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthLayout } from '../../components/AuthLayout';
import { Alert, Button, Field, Input } from '../../components/ui/core';
import { useAuth } from '../../lib/auth';
import { updateMyName } from '../../lib/studentApi';
import { friendlyError } from '../../lib/supabase';

export default function Onboarding() {
  const { student, setStudent, signOut } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy || !student) return;
    const n = name.trim();
    if (!n) return setErr('Please enter your full name.');
    if (n.length > 120) return setErr('Please use 120 characters or fewer.');
    setErr(null);
    setBusy(true);
    try {
      setStudent(await updateMyName(student.id, n));
      nav('/app', { replace: true });
    } catch (e) {
      setFormErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      footer={
        <button className="hover:text-ink" onClick={() => signOut()}>
          Not {student?.roll_number}? Sign out
        </button>
      }
    >
      <p className="eyebrow tnum">{student?.roll_number}</p>
      <h1 className="mt-2 text-[22px] font-semibold tracking-tight">Let's set up your workspace.</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">Your name is shown only to you and the placement administrator.</p>
      <Form onSubmit={() => submit()} noValidate className="mt-6 space-y-4">
        {formErr && <Alert>{formErr}</Alert>}
        <Field label="Full name" error={err}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              autoCapitalize="words"
              data-autofocus
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Save and continue
        </Button>
      </Form>
    </AuthLayout>
  );
}
