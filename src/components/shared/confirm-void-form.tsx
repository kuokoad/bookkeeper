'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending}>
      {pending ? 'Voiding…' : 'Yes, void it'}
    </Button>
  );
}

/**
 * Shared confirmation for voiding a financial document.
 *
 * Two steps and a written reason — never a single unguarded click, because a
 * void moves money and stock.
 */
export function ConfirmVoidForm({
  action,
  reference,
  title,
  description,
  placeholder,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  reference: string;
  title: string;
  description: string;
  placeholder: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="text-sm font-semibold text-content">{title}</h2>
        <p className="mt-1 mb-3 text-sm text-content-muted">{description}</p>
        <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
          Void {reference}…
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="rounded-xl border border-danger/40 bg-danger-soft p-4" noValidate>
      <h2 className="text-sm font-semibold text-content">Void {reference}?</h2>
      <p className="mt-1 mb-3 text-sm text-content-muted">Nothing is deleted.</p>

      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <Field label="Reason" htmlFor="void-reason" required error={state.fieldErrors?.['reason']}>
        <TextInput
          id="void-reason"
          name="reason"
          placeholder={placeholder}
          required
          autoFocus
          invalid={Boolean(state.fieldErrors?.['reason'])}
        />
      </Field>

      <div className="mt-4 flex items-center gap-3">
        <SubmitButton />
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
