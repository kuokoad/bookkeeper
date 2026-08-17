'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { voidSaleAction } from '@/actions/sale.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="danger" disabled={pending}>
      {pending ? 'Voiding…' : 'Yes, void this sale'}
    </Button>
  );
}

/** Voiding a sale moves money and stock, so it is confirmed and reasoned. */
export function VoidSaleForm({ saleId, reference }: { saleId: number; reference: string }) {
  const action = voidSaleAction.bind(null, saleId);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="text-sm font-semibold text-content">Void this sale</h2>
        <p className="mt-1 mb-3 text-sm text-content-muted">
          Stock goes back at the cost it left at, the money comes back out, and any balance owing is
          cancelled. The original sale is kept.
        </p>
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
          placeholder="e.g. Wrong item scanned"
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
