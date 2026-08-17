'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

export interface SupplierFormValues {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function SupplierForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  initial: SupplierFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Supplier name" htmlFor="name" required error={state.fieldErrors?.['name']}>
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

          <Field label="Contact person" htmlFor="contactPerson">
            <TextInput id="contactPerson" name="contactPerson" defaultValue={initial.contactPerson} />
          </Field>

          <Field label="Phone" htmlFor="phone">
            <TextInput
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              defaultValue={initial.phone}
              placeholder="e.g. 024 000 0000"
            />
          </Field>

          <Field label="Email" htmlFor="email">
            <TextInput id="email" name="email" type="email" defaultValue={initial.email} />
          </Field>

          <Field label="Address" htmlFor="address">
            <TextInput id="address" name="address" defaultValue={initial.address} />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Notes" htmlFor="notes">
              <TextInput id="notes" name="notes" defaultValue={initial.notes} />
            </Field>
          </div>
        </div>
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
