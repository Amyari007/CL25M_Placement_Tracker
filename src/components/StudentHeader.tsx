import { AppLink } from './AppLink';
import { Form } from './Form';
import { useState } from 'react';
import { Button, Field, Input, Wordmark } from './ui/core';
import { Dialog, Menu, MenuItem, useToast } from './ui/overlay';
import { useAuth } from '../lib/auth';
import { updateMyName } from '../lib/studentApi';
import { friendlyError } from '../lib/supabase';

export function StudentHeader() {
  const { student, signOut, setStudent } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!student) return null;
  const initials = (student.name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  async function saveName() {
    if (!name.trim()) return setErr('Please enter your name.');
    if (name.trim().length > 120) return setErr('Please use 120 characters or fewer.');
    setBusy(true);
    try {
      setStudent(await updateMyName(student!.id, name));
      setEditing(false);
      toast('Name updated');
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <AppLink to="/app" aria-label="CL25M Placement Tracker home">
            <Wordmark />
          </AppLink>
          <nav className="hidden sm:block" aria-label="Main">
            <span className="rounded-md bg-ink-50 px-2.5 py-1.5 text-sm font-medium text-ink" aria-current="page">
              My applications
            </span>
          </nav>
        </div>
        <Menu
          label="Account menu"
          trigger={
            <>
              <span className="hidden text-right sm:block">
                <span className="block text-sm font-medium leading-tight text-ink">{student.name}</span>
                <span className="tnum block text-xs leading-tight text-muted">{student.roll_number}</span>
              </span>
              <span className="grid h-8 w-8 place-items-center rounded-full bg-ink text-xs font-semibold text-white" aria-hidden="true">
                {initials}
              </span>
            </>
          }
        >
          {(close) => (
            <>
              <div className="border-b border-line px-3.5 pb-2.5 pt-1.5 sm:hidden">
                <p className="text-sm font-medium">{student.name}</p>
                <p className="tnum text-xs text-muted">{student.roll_number}</p>
              </div>
              <MenuItem
                onClick={() => {
                  close();
                  setName(student.name ?? '');
                  setErr(null);
                  setEditing(true);
                }}
              >
                Edit name
              </MenuItem>
              <AppLink to="/privacy" role="menuitem" className="block px-3.5 py-2.5 text-sm text-ink hover:bg-canvas" onClick={close}>
                Privacy notice
              </AppLink>
              <div className="my-1 border-t border-line" />
              <MenuItem tone="danger" onClick={() => signOut()}>
                Sign out
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      <Dialog
        open={editing}
        onClose={() => !busy && setEditing(false)}
        title="Edit your name"
        description={`Your roll number (${student.roll_number}) cannot be changed.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={saveName} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        <Form
          onSubmit={() => {
            saveName();
          }}
        >
          <Field label="Full name" error={err}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-autofocus />
            )}
          </Field>
        </Form>
      </Dialog>
    </header>
  );
}
