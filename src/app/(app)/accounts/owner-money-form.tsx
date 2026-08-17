'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  recordOwnerCapitalAction,
  recordOwnerDrawingsAction,
} from '@/actions/cashbook.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Recording…' : label}
    </Button>
  );
}

/**
 * The owner putting money in, or taking money out.
 *
 * Deliberately explained in the UI: money the owner takes out is NOT a business
 * expense, and money they put in is NOT income. Getting this wrong is the most
 * common way a small shop's profit figure ends up meaningless.
 */
export function OwnerMoneyForm({
  accounts,
  today,
  currencyCode,
}: {
  accounts: { id: number; name: string; isDefault: boolean }[];
  today: string;
  currencyCode: string;
}) {
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const action = direction === 'IN' ? recordOwnerCapitalAction : recordOwnerDrawingsAction;
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Owner put money in / took money out
      </Button>
    );
  }

  return (
    <form
      // Remounting on direction change clears any error left from the other one.
      key={direction}
      action={formAction}
      className="rounded-xl border border-line bg-surface-raised p-4"
      noValidate
    >
      <h2 className="mb-3 text-sm font-semibold text-content">Owner money</h2>

      <div className="mb-4 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={direction === 'IN' ? 'primary' : 'secondary'}
          onClick={() => setDirection('IN')}
          aria-pressed={direction === 'IN'}
        >
          Put money in
        </Button>
        <Button
          type="button"
          size="sm"
          variant={direction === 'OUT' ? 'primary' : 'secondary'}
          onClick={() => setDirection('OUT')}
          aria-pressed={direction === 'OUT'}
        >
          Take money out
        </Button>
      </div>

      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Date" htmlFor="businessDate" required error={state.fieldErrors?.['businessDate']}>
          <TextInput id="businessDate" name="businessDate" type="date" defaultValue={today} required />
        </Field>

        <Field
          label={direction === 'IN' ? 'Into' : 'Out of'}
          htmlFor="paymentAccountId"
          required
          error={state.fieldErrors?.['paymentAccountId']}
        >
          <select
            id="paymentAccountId"
            name="paymentAccountId"
            defaultValue={String(accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? '')}
            required
            className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
          >
            {accounts.map((account) => (
              <option key={account.id} value={String(account.id)}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={`Amount (${currencyCode})`}
          htmlFor="amount"
          required
          error={state.fieldErrors?.['amount']}
        >
          <AmountInput
            id="amount"
            name="amount"
            placeholder="0.00"
            required
            invalid={Boolean(state.fieldErrors?.['amount'])}
          />
        </Field>

        <Field label="What for" htmlFor="description">
          <TextInput
            id="description"
            name="description"
            placeholder={direction === 'IN' ? 'e.g. Extra float' : 'e.g. School fees'}
          />
        </Field>
      </div>

      <p className="mt-3 text-xs text-content-subtle">
        {direction === 'IN'
          ? 'Money you put in increases your stake in the business. It is not counted as income, so it will not inflate your profit.'
          : 'Money you take out reduces your stake in the business. It is not a business expense, so it will not reduce your reported profit.'}
      </p>

      <div className="mt-4 flex items-center gap-3">
        <SubmitButton label={direction === 'IN' ? 'Record money in' : 'Record money out'} />
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
