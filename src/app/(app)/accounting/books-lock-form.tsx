'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { setBooksLockAction } from '@/actions/accounting.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';

function SubmitButton({ reopening }: { reopening: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={reopening ? 'danger' : 'primary'} disabled={pending}>
      {pending ? 'Saving…' : reopening ? 'Yes, reopen the books' : 'Close the books'}
    </Button>
  );
}

/**
 * Setting the books lock.
 *
 * Closing a period forward is routine. Moving the lock BACK reopens a period
 * that was declared final, so the button changes colour and wording — the user
 * should never do that without noticing they are doing it.
 */
export function BooksLockForm({
  lockedBefore,
  entriesLocked,
  today,
}: {
  lockedBefore: string | null;
  entriesLocked: number;
  today: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(setBooksLockAction, {});
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(lockedBefore ?? '');

  const reopening =
    lockedBefore !== null && (value === '' || value < lockedBefore);

  if (!open) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="text-sm font-semibold text-content">Books lock</h2>
        {lockedBefore === null ? (
          <p className="mt-1 mb-3 text-sm text-content-muted">
            Nothing is locked. Anyone with permission can record a transaction dated any day,
            including in a month you have already reviewed.
          </p>
        ) : (
          <p className="mt-1 mb-3 text-sm text-content-muted">
            The books are closed up to <strong className="text-content">{lockedBefore}</strong>.{' '}
            {entriesLocked} entry(ies) are protected. Nothing dated on or before that day can be
            recorded or changed.
          </p>
        )}
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {lockedBefore === null ? 'Close the books up to a date…' : 'Change the lock date…'}
        </Button>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className={`rounded-xl border p-4 ${reopening ? 'border-danger/40 bg-danger-soft' : 'border-line bg-surface-raised'}`}
      noValidate
    >
      <h2 className="mb-1 text-sm font-semibold text-content">
        {reopening ? 'Reopen a closed period?' : 'Close the books'}
      </h2>
      <p className="mb-3 text-sm text-content-muted">
        Transactions dated on or before this day will be refused. Leave it blank to remove the lock
        entirely.
      </p>

      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="max-w-xs">
        <Field
          label="Closed up to and including"
          htmlFor="lockedBefore"
          error={state.fieldErrors?.['lockedBefore']}
          hint={`Today is ${today}.`}
        >
          <DateField
            id="lockedBefore"
            name="lockedBefore"
            value={value}
            onChange={setValue}
            today={today}
            invalid={Boolean(state.fieldErrors?.['lockedBefore'])}
          />
        </Field>
      </div>

      {reopening && (
        <Alert tone="danger" className="mt-3">
          This reopens a period that was declared final. It will be recorded in the audit log as a
          reopening, with your name against it.
        </Alert>
      )}

      <p className="mt-3 text-xs text-content-subtle">
        Mistakes in a closed period are still correctable — void the transaction, which posts a
        dated reversal today rather than quietly rewriting history.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <SubmitButton reopening={reopening} />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setValue(lockedBefore ?? '');
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
