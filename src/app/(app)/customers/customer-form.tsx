'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';

export interface CustomerFormValues {
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  creditLimit: string;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function CustomerForm({
  action,
  initial,
  submitLabel,
  currencyCode,
  cancelHref,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  initial: CustomerFormValues;
  submitLabel: string;
  currencyCode: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name" htmlFor="name" required error={state.fieldErrors?.['name']}>
              <TextInput
                id="name"
                name="name"
                defaultValue={initial.name}
                required
                autoFocus
                invalid={Boolean(state.fieldErrors?.['name'])}
              />
            </Field>
          </div>

          <Field label="Phone" htmlFor="phone" error={state.fieldErrors?.['phone']}>
            <TextInput
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              defaultValue={initial.phone}
              placeholder="e.g. 024 000 0000"
            />
          </Field>

          <Field label="Email" htmlFor="email" error={state.fieldErrors?.['email']}>
            <TextInput id="email" name="email" type="email" defaultValue={initial.email} />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Address" htmlFor="address">
              <TextInput id="address" name="address" defaultValue={initial.address} />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="notes">
              <TextInput id="notes" name="notes" defaultValue={initial.notes} />
            </Field>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">Credit</h2>
        <Field
          label={`Credit limit (${currencyCode})`}
          htmlFor="creditLimit"
          hint="Leave blank for no limit. Enter 0 to stop this customer buying on credit at all."
          error={state.fieldErrors?.['creditLimit']}
        >
          <AmountInput
            id="creditLimit"
            name="creditLimit"
            defaultValue={initial.creditLimit}
            placeholder="No limit"
            invalid={Boolean(state.fieldErrors?.['creditLimit'])}
            className="max-w-xs"
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton label={submitLabel} />
        <Link href={cancelHref}>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
