'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { cancelQuotationAction, convertQuotationAction } from '@/actions/quotation.actions';
import type { FormState } from '@/actions/auth.actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';
import { AmountInput, Field, TextInput } from '@/components/ui/field';

/**
 * Accepting a quote, or withdrawing it.
 *
 * Converting is the only thing in the quotations feature that touches the books,
 * so it is deliberately a separate, explicit step rather than something that can
 * happen while editing. What comes out the other side is an ordinary sale.
 */

function Submit({ label, tone }: { label: string; tone?: 'secondary' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...(tone ? { variant: tone } : {})}>
      {pending ? 'Working…' : label}
    </Button>
  );
}

export function ConvertPanel({
  quotationId,
  customerName,
  hasCustomer,
  totalMinor,
  currencyCode,
  expired,
  validUntil,
  today,
  canCancel,
  accounts,
  defaultTermsDays,
}: {
  quotationId: number;
  customerName: string;
  hasCustomer: boolean;
  totalMinor: number;
  currencyCode: string;
  expired: boolean;
  validUntil: string;
  today: string;
  canCancel: boolean;
  accounts: { id: number; name: string }[];
  defaultTermsDays: number;
}) {
  const [convertState, convertAction] = useActionState<FormState, FormData>(
    convertQuotationAction,
    {},
  );
  const [cancelState, cancelAction] = useActionState<FormState, FormData>(
    cancelQuotationAction,
    {},
  );

  const asMajor = (totalMinor / 100).toFixed(2);
  const [accountId, setAccountId] = useState(String(accounts[0]?.id ?? ''));
  const [paying, setPaying] = useState(asMajor);
  const [showCancel, setShowCancel] = useState(false);

  const tenders = JSON.stringify(
    paying.trim() === '' || Number(paying) === 0
      ? []
      : [{ paymentAccountId: Number(accountId), amount: paying.trim() }],
  );

  const owing = Math.max(0, totalMinor - Math.round(Number(paying || '0') * 100));

  return (
    <>
      <Card className="mb-4">
        <h2 className="mb-1 text-sm font-semibold text-content">The customer accepted</h2>
        <p className="mb-4 text-sm text-content-muted">
          This rings the goods up at the prices on this quote, even if the shelf price has moved
          since. Stock leaves and the books are posted, exactly as at the till.
        </p>

        {convertState.error && (
          <Alert tone="danger" className="mb-4">
            {convertState.error}
          </Alert>
        )}

        <form action={convertAction} className="space-y-4" noValidate>
          <input type="hidden" name="quotationId" value={quotationId} />
          <input type="hidden" name="tenders" value={tenders} />
          <input type="hidden" name="businessDate" value={today} />

          {expired && (
            <Field
              label="Why is this still being honoured?"
              htmlFor="overrideReason"
              required
              hint={`The price was only promised to ${validUntil}. Whatever you type is kept with the quote.`}
              error={convertState.fieldErrors?.['overrideReason']}
            >
              <TextInput id="overrideReason" name="overrideReason" required />
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="account" className="mb-1 block text-sm text-content-muted">
                Paid into
              </label>
              <select
                id="account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                className="h-10 w-full rounded-lg border border-line bg-surface-raised px-3 text-sm text-content"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>

            <Field label="Paying now" htmlFor="paying">
              <AmountInput
                id="paying"
                value={paying}
                onChange={(event) => setPaying(event.target.value)}
              />
            </Field>

            <div className="self-end pb-2 text-sm">
              <span className="text-content-muted">Total </span>
              <span className="tabular font-semibold text-content">
                {currencyCode} {asMajor}
              </span>
              {owing > 0 && (
                <p className="mt-1 text-xs text-warning">
                  {currencyCode} {(owing / 100).toFixed(2)} will be owed
                </p>
              )}
            </div>
          </div>

          {/*
            A part-paid sale has to be owed by somebody. The quote already knows
            the name; without a record on the books there is nothing to hang the
            debt on, so one is created from that name at this moment rather than
            asking the owner to break off and do it first.
          */}
          {owing > 0 && !hasCustomer && (
            <div className="rounded-xl border border-line p-3">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  name="createCustomer"
                  defaultChecked
                  className="mt-1 h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-sm">
                  <span className="block font-medium text-content">
                    Add {customerName} to your customers
                  </span>
                  <span className="mt-0.5 block text-xs text-content-muted">
                    Needed to record what is still owed, and to send a statement later.
                  </span>
                </span>
              </label>
              <div className="mt-3 max-w-[12rem]">
                <Field label="Days to pay" htmlFor="termsDays">
                  <TextInput
                    id="termsDays"
                    name="termsDays"
                    inputMode="numeric"
                    defaultValue={String(defaultTermsDays)}
                  />
                </Field>
              </div>
            </div>
          )}

          <Submit label="Turn into a sale" />
        </form>
      </Card>

      {canCancel && (
        <Card>
          <h2 className="mb-1 text-sm font-semibold text-content">
            The customer went somewhere else
          </h2>
          <p className="mb-3 text-sm text-content-muted">
            Cancelling closes the quote. Nothing is deleted: it stays on file, keeps its number and
            can still be printed, because a price the shop once offered is worth being able to look
            up.
          </p>

          {cancelState.error && (
            <Alert tone="danger" className="mb-3">
              {cancelState.error}
            </Alert>
          )}

          {showCancel ? (
            <form action={cancelAction} className="space-y-3" noValidate>
              <input type="hidden" name="quotationId" value={quotationId} />
              <Field
                label="Why?"
                htmlFor="reason"
                required
                error={cancelState.fieldErrors?.['reason']}
              >
                <TextInput
                  id="reason"
                  name="reason"
                  required
                  invalid={Boolean(cancelState.fieldErrors?.['reason'])}
                />
              </Field>
              <div className="flex gap-2">
                <Submit label="Cancel this quote" tone="secondary" />
                <Button type="button" variant="ghost" onClick={() => setShowCancel(false)}>
                  Keep it open
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowCancel(true)}>
              Cancel this quote
            </Button>
          )}
        </Card>
      )}
    </>
  );
}
