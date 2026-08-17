'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { createPaymentAccountAction } from '@/actions/cashbook.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Adding…' : 'Add account'}
    </Button>
  );
}

/**
 * Adding a payment account.
 *
 * `provider` is free text on purpose — a new mobile money network is data
 * entry, not a code change, which is what §31 of the brief asks for.
 */
export function NewAccountForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createPaymentAccountAction, {});
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('MOBILE_MONEY');

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add an account
      </Button>
    );
  }

  return (
    <form action={formAction} className="rounded-xl border border-line bg-surface-raised p-4" noValidate>
      <h2 className="mb-3 text-sm font-semibold text-content">Add a payment account</h2>

      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="name" required error={state.fieldErrors?.['name']}>
          <TextInput
            id="name"
            name="name"
            placeholder="e.g. Telecel Cash"
            required
            autoFocus
            invalid={Boolean(state.fieldErrors?.['name'])}
          />
        </Field>

        <Field label="Type" htmlFor="kind" required>
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
          >
            <option value="CASH">Cash</option>
            <option value="MOBILE_MONEY">Mobile money</option>
            <option value="BANK">Bank</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>

        <Field
          label="Provider"
          htmlFor="provider"
          hint="e.g. MTN, Telecel, AirtelTigo, GCB. Anything you like."
        >
          <TextInput id="provider" name="provider" placeholder="Optional" />
        </Field>

        <Field label="Account or wallet number" htmlFor="accountNumber">
          <TextInput id="accountNumber" name="accountNumber" placeholder="Optional" />
        </Field>

        <div className="flex items-start gap-3 sm:col-span-2">
          <input
            id="isDefault"
            name="isDefault"
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-line-strong"
          />
          <label htmlFor="isDefault" className="text-sm text-content">
            Make this the default at the till
            <span className="mt-0.5 block text-xs text-content-subtle">
              Pre-selected when taking payment. Only one account can be the default.
            </span>
          </label>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <SubmitButton />
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
