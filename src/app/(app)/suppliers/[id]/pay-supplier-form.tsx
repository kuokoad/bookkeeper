'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { paySupplierAction } from '@/actions/purchase.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';

function fmt(minorValue: number): string {
  const digits = Math.abs(Math.round(minorValue)).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minorValue < 0 ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Recording…' : 'Record payment'}
    </Button>
  );
}

/** Paying a supplier. Applied to the oldest unpaid delivery first. */
export function PaySupplierForm({
  supplierId,
  supplierName,
  balanceMinor,
  accounts,
  today,
  currencyCode,
}: {
  supplierId: number;
  supplierName: string;
  balanceMinor: number;
  accounts: { id: number; name: string; isDefault: boolean }[];
  today: string;
  currencyCode: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(paySupplierAction, {});
  const [amount, setAmount] = useState('');

  return (
    <form action={formAction} className="rounded-xl border border-line bg-surface-raised p-4" noValidate>
      <input type="hidden" name="supplierId" value={supplierId} />

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-content">Pay this supplier</h2>
        <p className="text-sm text-content-muted">
          You owe {supplierName}{' '}
          <span className="tabular font-semibold text-warning">
            {currencyCode} {fmt(balanceMinor)}
          </span>
        </p>
      </div>

      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Date" htmlFor="businessDate" required error={state.fieldErrors?.['businessDate']}>
          <DateField id="businessDate" name="businessDate" defaultValue={today} required />
        </Field>

        <Field label="Paid from" htmlFor="paymentAccountId" required>
          <select
            id="paymentAccountId"
            name="paymentAccountId"
            defaultValue={String(accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? '')}
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
          <div className="flex gap-2">
            <AmountInput
              id="amount"
              name="amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              required
              invalid={Boolean(state.fieldErrors?.['amount'])}
            />
            <Button type="button" variant="secondary" onClick={() => setAmount(fmt(balanceMinor))}>
              All
            </Button>
          </div>
        </Field>

        <Field label="Reference" htmlFor="reference">
          <TextInput id="reference" name="reference" placeholder="Optional" />
        </Field>
      </div>

      <p className="mt-3 text-xs text-content-subtle">
        Applied to the oldest unpaid delivery first.
      </p>

      <div className="mt-4">
        <SubmitButton />
      </div>
    </form>
  );
}
