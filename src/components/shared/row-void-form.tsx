'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/field';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" size="sm" disabled={pending}>
      {pending ? 'Voiding…' : 'Void'}
    </Button>
  );
}

/**
 * Voiding a document that lives in a list rather than on a page of its own.
 *
 * Payments, expenses, incomes and reconciliations are never opened
 * individually — they are rows — so `ConfirmVoidForm`, which is a card, has
 * nowhere to sit. This keeps the two things about that component that matter
 * and drops the ones that only suit a page: a void still takes TWO deliberate
 * actions and still requires a written reason, because it moves money.
 *
 * The reason is typed in the row itself. A dialog would be tidier to look at
 * and worse to use: on the counter machine it would cover the very line the
 * person is checking they have the right one.
 */
export function RowVoidForm({
  action,
  what,
  placeholder,
  returnTo,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  /** What is being voided, for the confirmation line. e.g. "RCV-00002". */
  what: string;
  placeholder: string;
  /** The filters the list was showing, so voiding a row comes back to them. */
  returnTo?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        aria-label={`Void ${what}`}
      >
        Void
      </Button>
    );
  }

  return (
    <form action={formAction} noValidate className="min-w-56">
      <input type="hidden" name="returnTo" value={returnTo ?? ''} />
      <p className="mb-1.5 text-xs text-content-muted">
        Void {what}? Nothing is deleted — a reversing entry is posted.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          name="reason"
          placeholder={placeholder}
          required
          autoFocus
          className="h-9 w-44"
          invalid={Boolean(state.fieldErrors?.['reason'])}
          aria-label={`Reason for voiding ${what}`}
        />
        <SubmitButton />
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>

      {state.fieldErrors?.['reason'] && (
        <p className="mt-1 text-xs font-medium text-danger">{state.fieldErrors['reason']}</p>
      )}
      {state.error && <p className="mt-1 text-xs font-medium text-danger">{state.error}</p>}
    </form>
  );
}
