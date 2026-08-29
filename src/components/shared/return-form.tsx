'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';

export interface ReturnableItem {
  id: number;
  productName: string;
  unit: string;
  returnableMilli: number;
  /** Unit price for a sale return, unit cost for a purchase return. */
  unitAmountMinor: number;
}

function fmt(minorValue: number): string {
  const digits = Math.abs(Math.round(minorValue)).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minorValue < 0 ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

function fmtQty(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const fraction = Math.abs(milli % 1000).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function toMilli(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (!/^\d*\.?\d{0,3}$/.test(trimmed)) return Number.NaN;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole || '0') * 1000 + Number(fraction.padEnd(3, '0') || '0');
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Recording…' : label}
    </Button>
  );
}

/**
 * Recording goods coming back, in either direction.
 *
 * Each line shows how much is still returnable, so the same goods cannot be
 * sent back twice. Money can be handed back now, or the balance reduced.
 */
export function ReturnForm({
  action,
  items,
  accounts,
  today,
  currencyCode,
  title,
  description,
  submitLabel,
  creditLabel,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  items: ReturnableItem[];
  accounts: { id: number; name: string; isDefault: boolean }[];
  today: string;
  currencyCode: string;
  title: string;
  description: string;
  submitLabel: string;
  creditLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [open, setOpen] = useState(false);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [refund, setRefund] = useState('');

  const estimatedValue = items.reduce((total, item) => {
    const milli = toMilli(quantities[item.id] ?? '');
    if (Number.isNaN(milli) || milli <= 0) return total;
    return total + Math.round((item.unitAmountMinor * milli) / 1000);
  }, 0);

  if (!open) {
    return (
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="text-sm font-semibold text-content">{title}</h2>
        <p className="mt-1 mb-3 text-sm text-content-muted">{description}</p>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Record a return…
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="rounded-xl border border-line bg-surface-raised p-4" noValidate>
      <h2 className="mb-3 text-sm font-semibold text-content">{title}</h2>

      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="mb-4 max-w-xs">
        <label htmlFor="return-date" className="mb-1 block text-xs text-content-muted">
          Date
        </label>
        <DateField id="return-date" name="businessDate" defaultValue={today} required />
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const value = quantities[item.id] ?? '';
          const milli = toMilli(value);
          const tooMany = !Number.isNaN(milli) && milli > item.returnableMilli;

          return (
            <div
              key={item.id}
              className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-line p-3"
            >
              <input type="hidden" name="itemId" value={item.id} />
              <div className="min-w-0">
                <p className="font-medium text-content">{item.productName}</p>
                <p className="text-xs text-content-subtle">
                  {fmtQty(item.returnableMilli)} {item.unit} can still be returned ·{' '}
                  {currencyCode} {fmt(item.unitAmountMinor)} each
                </p>
              </div>
              <div className="w-32">
                <label
                  htmlFor={`ret-${item.id}`}
                  className="mb-1 block text-xs text-content-muted"
                >
                  Return qty
                </label>
                <AmountInput
                  id={`ret-${item.id}`}
                  name="qty"
                  value={value}
                  onChange={(event) =>
                    setQuantities((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                  placeholder="0"
                  invalid={Number.isNaN(milli) || tooMany}
                  className="h-10"
                />
                {tooMany && (
                  <p className="mt-1 text-xs font-medium text-danger">
                    Max {fmtQty(item.returnableMilli)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="refundAccountId" className="mb-1 block text-xs text-content-muted">
            Money handed back via
          </label>
          <select
            id="refundAccountId"
            name="refundAccountId"
            defaultValue={String(accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? '')}
            className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
          >
            {accounts.map((account) => (
              <option key={account.id} value={String(account.id)}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="refundAmount" className="mb-1 block text-xs text-content-muted">
            Amount refunded
          </label>
          <AmountInput
            id="refundAmount"
            name="refundAmount"
            value={refund}
            onChange={(event) => setRefund(event.target.value)}
            placeholder="0.00"
            invalid={Boolean(state.fieldErrors?.['refundAmount'])}
          />
        </div>
        <div>
          <label htmlFor="return-reason" className="mb-1 block text-xs text-content-muted">
            Reason
          </label>
          <TextInput id="return-reason" name="reason" placeholder="e.g. Damaged" />
        </div>
      </div>

      <p className="mt-3 text-xs text-content-subtle">
        Value of goods being returned: {currencyCode} {fmt(estimatedValue)}. Anything not refunded
        in cash {creditLabel}.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <SubmitButton label={submitLabel} />
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
