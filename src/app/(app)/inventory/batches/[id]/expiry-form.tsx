'use client';

import { useActionState } from 'react';

import { setBatchExpiryAction } from '@/actions/inventory.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { TextInput } from '@/components/ui/field';

/**
 * Correcting the date on a crate.
 *
 * Here for one situation above all: on the day a shop installs this, every
 * batch is opened undated, because the goods were bought before anybody was
 * asked for a date. For a shop selling milk and bread, "this stock does not
 * expire" is false on day one and there is no other way to make it true.
 *
 * Nothing about the quantity or the value changes. What changes is which crate
 * the till reaches for next, and whether it refuses — so the service audits the
 * old date alongside the new one.
 */
export function ExpiryForm({
  batchId,
  batchRef,
  expiryDate,
}: {
  batchId: number;
  batchRef: string;
  expiryDate: string | null;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    setBatchExpiryAction.bind(null, batchId),
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="w-48">
        <label
          htmlFor="expiryDate"
          className="mb-1 block text-xs font-medium text-content-muted"
        >
          {expiryDate === null ? 'Set a date' : 'Change the date'}
        </label>
        <TextInput
          id="expiryDate"
          name="expiryDate"
          type="date"
          defaultValue={expiryDate ?? ''}
          invalid={state.fieldErrors?.['expiryDate'] !== undefined}
        />
      </div>

      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>

      <p className="w-full text-xs text-content-muted">
        {expiryDate === null
          ? `${batchRef} has no date, so nothing will ever warn about it. Stock already on the shelf when this shop started recording batches arrives here.`
          : 'Changing this changes which stock the till reaches for first, and whether it refuses a sale. It is recorded in the audit log.'}
      </p>

      {state.error && (
        <Alert tone="danger" className="w-full">
          {state.error}
        </Alert>
      )}
      {state.fieldErrors?.['expiryDate'] && (
        <p className="w-full text-xs font-medium text-danger">
          {state.fieldErrors['expiryDate']}
        </p>
      )}
      {state.success && (
        <Alert tone="success" className="w-full">
          {state.success}
        </Alert>
      )}
    </form>
  );
}
