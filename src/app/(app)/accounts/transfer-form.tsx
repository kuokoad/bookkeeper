'use client';

import { Select } from '@/components/ui/select';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { recordTransferAction } from '@/actions/cashbook.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';
import { addDays } from '@/domain/business-date';
import { formatDate } from '@/lib/format';

export interface TransferAccount {
  id: number;
  name: string;
  kind: string;
  isDefault: boolean;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Recording…' : 'Record transfer'}
    </Button>
  );
}

const SELECT_CLASS =
  'h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content';

/**
 * Money moved between the shop's own accounts — most often the day's cash
 * taken to the bank.
 *
 * Starts on that case: out of the default (usually the cash drawer), into the
 * first bank account. It is the one people do every week, and the one they
 * were recording as owner money in and out before this existed.
 */
export function TransferForm({
  accounts,
  today,
  lockedBefore,
  currencyCode,
}: {
  accounts: TransferAccount[];
  today: string;
  lockedBefore: string | null;
  currencyCode: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(recordTransferAction, {});
  const [open, setOpen] = useState(false);

  const defaultFrom = accounts.find((a) => a.isDefault) ?? accounts[0];
  const defaultTo =
    accounts.find((a) => a.kind === 'BANK' && a.id !== defaultFrom?.id) ??
    accounts.find((a) => a.id !== defaultFrom?.id);

  if (accounts.length < 2) return null;

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Move money between accounts
      </Button>
    );
  }

  return (
    <form
      // A fresh form after each transfer, so the next one cannot be sent twice
      // by accident with the last one's amount still in the box.
      key={state.success ?? 'new'}
      action={formAction}
      className="rounded-xl border border-line bg-surface-raised p-4"
      noValidate
    >
      <h2 className="mb-3 text-sm font-semibold text-content">Move money between accounts</h2>

      {state.success && (
        <Alert tone="success" className="mb-3">
          {state.success} Both balances have been updated.
        </Alert>
      )}
      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Field
          label="Date"
          htmlFor="transfer-date"
          required
          error={state.fieldErrors?.['businessDate']}
        >
          <DateField
            id="transfer-date"
            name="businessDate"
            label="Transfer date"
            defaultValue={today}
            today={today}
            min={lockedBefore ? addDays(lockedBefore, 1) : undefined}
            minReason={
              lockedBefore ? `The books are closed up to ${formatDate(lockedBefore)}.` : undefined
            }
            required
          />
        </Field>

        <Field label="From" htmlFor="fromAccountId" required error={state.fieldErrors?.['fromAccountId']}>
          <Select
            id="fromAccountId"
            name="fromAccountId"
            defaultValue={String(defaultFrom?.id ?? '')}
            required
            className={SELECT_CLASS}
          >
            {accounts.map((account) => (
              <option key={account.id} value={String(account.id)}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="To" htmlFor="toAccountId" required error={state.fieldErrors?.['toAccountId']}>
          <Select
            id="toAccountId"
            name="toAccountId"
            defaultValue={String(defaultTo?.id ?? '')}
            required
            className={SELECT_CLASS}
          >
            {accounts.map((account) => (
              <option key={account.id} value={String(account.id)}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={`Amount (${currencyCode})`}
          htmlFor="transfer-amount"
          required
          error={state.fieldErrors?.['amount']}
        >
          <AmountInput
            id="transfer-amount"
            name="amount"
            placeholder="0.00"
            required
            invalid={Boolean(state.fieldErrors?.['amount'])}
          />
        </Field>

        <Field label="Reference" htmlFor="transfer-reference" error={state.fieldErrors?.['reference']}>
          <TextInput id="transfer-reference" name="reference" placeholder="e.g. Deposit slip no." />
        </Field>

        <Field label="Note" htmlFor="transfer-note" error={state.fieldErrors?.['note']}>
          <TextInput id="transfer-note" name="note" />
        </Field>
      </div>

      <p className="mt-3 text-xs text-content-subtle">
        Moving money between your own accounts is not income or spending. The total you hold stays
        the same, and your profit is not touched.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <SubmitButton />
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
