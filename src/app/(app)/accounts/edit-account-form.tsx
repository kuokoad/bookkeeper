'use client';

import { useActionState, useState } from 'react';
import { updatePaymentAccountAction } from '@/actions/cashbook.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

type EditableAccount = {
  id: number;
  name: string;
  provider: string | null;
  kind: string;
  accountNumber: string | null;
  isDefault: boolean;
};

export function EditAccountForm({ account }: { account: EditableAccount }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    updatePaymentAccountAction.bind(null, account.id), {},
  );

  return (
    <div className="mb-4">
      <Button type="button" variant="secondary" size="sm" aria-expanded={open}
        aria-controls="edit-account-form" onClick={() => setOpen(!open)} disabled={pending}>
        {open ? 'Cancel editing' : 'Edit account'}
      </Button>
      {open && (
        <form id="edit-account-form" action={formAction}
          className="mt-3 border border-line bg-surface-raised p-4">
          <h2 className="mb-3 text-sm font-semibold text-content">Edit account</h2>
          {state.error && <Alert tone="danger" className="mb-3">{state.error}</Alert>}
          <input type="hidden" name="kind" value={account.kind} />
          <input type="hidden" name="accountNumber" value={account.accountNumber ?? ''} />
          {account.isDefault && <input type="hidden" name="isDefault" value="on" />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Account name" htmlFor="edit-account-name" required error={state.fieldErrors?.name}>
              <TextInput id="edit-account-name" name="name" defaultValue={account.name}
                required maxLength={80} autoFocus disabled={pending} invalid={Boolean(state.fieldErrors?.name)} />
            </Field>
            <Field label="Provider" htmlFor="edit-account-provider" error={state.fieldErrors?.provider}
              hint="Optional: bank or mobile money provider.">
              <TextInput id="edit-account-provider" name="provider" defaultValue={account.provider ?? ''}
                maxLength={60} disabled={pending} invalid={Boolean(state.fieldErrors?.provider)} />
            </Field>
          </div>
          <Button type="submit" className="mt-4" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      )}
    </div>
  );
}
