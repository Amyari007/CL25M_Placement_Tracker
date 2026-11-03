import { Form } from './Form';
import { useEffect, useMemo, useRef, useState } from 'react';
import { STAGES, STAGE_LABEL } from '../../supabase/functions/_shared/analytics.ts';
import type { ApplicationDraft, ApplicationRow, Stage } from '../lib/types';
import { Alert, Button, Field, Input, Select, Textarea } from './ui/core';
import { ConfirmDialog, Sheet } from './ui/overlay';

const EMPTY: ApplicationDraft = {
  company_name: '',
  test_date: '',
  role: '',
  application_stage: 'applied',
  stage_is_default: true,
  notes: '',
};

function fromRow(a: ApplicationRow): ApplicationDraft {
  return {
    company_name: a.company_name,
    test_date: a.test_date ?? '',
    role: a.role ?? '',
    application_stage: a.application_stage,
    stage_is_default: a.stage_is_default,
    notes: a.notes ?? '',
  };
}

export function ApplicationForm({
  open,
  editing,
  onClose,
  onSave,
  suggestions = [],
  saveLabel,
  footnote,
  validateCompany,
}: {
  suggestions?: string[];
  saveLabel?: string;
  footnote?: string;
  /** Returns an error message if the name clashes with another entry. */
  validateCompany?: (name: string) => string | null;
  open: boolean;
  editing: ApplicationRow | null;
  onClose: () => void;
  /** Throws on failure; the form stays open with the draft intact. */
  onSave: (d: ApplicationDraft) => Promise<void>;
}) {
  const initial = useMemo(() => (editing ? fromRow(editing) : EMPTY), [editing]);
  const [d, setD] = useState<ApplicationDraft>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof ApplicationDraft, string>>>({});
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (open) {
      setD(initial);
      setErrors({});
      setFormErr(null);
    }
  }, [open, initial]);

  const dirty = JSON.stringify(d) !== JSON.stringify(initial);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!open || !dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [open, dirty]);

  function requestClose() {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  function set<K extends keyof ApplicationDraft>(k: K, v: ApplicationDraft[K]) {
    setD((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  }

  async function submit() {
    if (busyRef.current) return; // prevents double submission
    const e: typeof errors = {};
    if (!d.company_name.trim()) e.company_name = 'Company name is required.';
    else if (d.company_name.trim().length > 120) e.company_name = 'Use 120 characters or fewer.';
    else if (validateCompany) e.company_name = validateCompany(d.company_name) ?? undefined;
    if (d.role.trim().length > 120) e.role = 'Use 120 characters or fewer.';
    if (d.notes.length > 2000) e.notes = 'Notes can be up to 2,000 characters.';
    if (d.test_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.test_date)) e.test_date = 'Enter a valid date.';
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    busyRef.current = true;
    setBusy(true);
    setFormErr(null);
    try {
      await onSave(d);
    } catch (err) {
      setFormErr((err as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={requestClose}
        title={editing ? 'Edit details' : 'Add application'}
        subtitle={editing ? editing.company_name : 'Only the company name is required.'}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose} disabled={busy} className="flex-1 sm:flex-none">
              Cancel
            </Button>
            <Button onClick={submit} loading={busy} className="flex-1 sm:flex-none">
              {busy ? 'Saving…' : saveLabel ?? (editing ? 'Save changes' : 'Save application')}
            </Button>
          </>
        }
      >
        <Form
          noValidate
          onSubmit={() => {
            submit();
          }}
          className="space-y-5"
        >
          {formErr && <Alert>{formErr}</Alert>}
          {footnote && <Alert tone="neutral">{footnote}</Alert>}
          <Field label="Company name" error={errors.company_name}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                aria-required="true"
                value={d.company_name}
                onChange={(e) => set('company_name', e.target.value)}
                placeholder="e.g. Philips"
                autoComplete="off"
                list="company-suggestions"
                enterKeyHint="next"
                data-autofocus
              />
            )}
          </Field>
          <Field label="Test or assessment date" optional error={errors.test_date} hint="Leave empty if it hasn't been announced yet.">
            {({ id, describedBy, invalid }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  type="date"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  value={d.test_date}
                  onChange={(e) => set('test_date', e.target.value)}
                  className="tnum"
                />
                {d.test_date && (
                  <Button variant="subtle" onClick={() => set('test_date', '')} aria-label="Clear date">
                    Clear
                  </Button>
                )}
              </div>
            )}
          </Field>
          <Field label="Role or position" optional error={errors.role}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={d.role}
                onChange={(e) => set('role', e.target.value)}
                placeholder="e.g. Clinical Applications Specialist"
              />
            )}
          </Field>
          <Field label="Application stage" optional hint={d.stage_is_default ? 'Defaults to “Applied” until you change it.' : undefined}>
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={d.application_stage}
                onChange={(e) => setD((x) => ({ ...x, application_stage: e.target.value as Stage, stage_is_default: false }))}
              >
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Notes" optional error={errors.notes}>
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={4}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                value={d.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Test format, contacts, links, reminders…"
              />
            )}
          </Field>
          <datalist id="company-suggestions">
            {suggestions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button type="submit" hidden />
        </Form>
      </Sheet>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard changes?"
        body="You have unsaved changes to this application."
        confirmLabel="Discard"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </>
  );
}
