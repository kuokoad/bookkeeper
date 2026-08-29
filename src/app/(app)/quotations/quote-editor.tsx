'use client';

import { useMemo, useState } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';
import { AmountInput, Field, TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';

/**
 * Writing a quote.
 *
 * Shared by the new and the edit screens, because a quote edited by a different
 * form from the one that wrote it is a quote that can be totalled two ways.
 *
 * Everything shown here is a PREVIEW. The figures the customer is promised are
 * computed on the server by the same function the till uses, and this arithmetic
 * exists only so the owner is not typing blind. Where the two could ever
 * disagree the server wins, which is why the lines are submitted as what was
 * typed rather than as anything worked out below.
 */

export interface EditorProduct {
  id: number;
  name: string;
  unit: string;
  sellingPrice: number;
}

export interface EditorCustomer {
  id: number;
  name: string;
  phone: string | null;
}

export interface QuoteEditorValues {
  quotationId?: number;
  businessDate: string;
  validUntil: string;
  customerName: string;
  customerId: number | null;
  customerPhone: string;
  reference: string;
  notes: string;
  quoteDiscount: string;
  lines: { productId: number; qty: string; unitPrice: string; discount: string }[];
}

interface Line {
  key: number;
  productId: string;
  qty: string;
  unitPrice: string;
  discount: string;
}

const toMinor = (value: string): number => {
  const cleaned = value.replace(/,/g, '').trim();
  if (cleaned === '') return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN;
};

const toMilli = (value: string): number => {
  const cleaned = value.replace(/,/g, '').trim();
  if (cleaned === '') return Number.NaN;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : Number.NaN;
};

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function QuoteEditor({
  action,
  values,
  products,
  customers,
  currencyCode,
  submitLabel,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  values: QuoteEditorValues;
  products: EditorProduct[];
  customers: EditorCustomer[];
  currencyCode: string;
  submitLabel: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  const [lines, setLines] = useState<Line[]>(() =>
    values.lines.length > 0
      ? values.lines.map((line, index) => ({
          key: index + 1,
          productId: String(line.productId),
          qty: line.qty,
          unitPrice: line.unitPrice,
          discount: line.discount,
        }))
      : [{ key: 1, productId: '', qty: '', unitPrice: '', discount: '' }],
  );
  const [quoteDiscount, setQuoteDiscount] = useState(values.quoteDiscount);
  const [customerName, setCustomerName] = useState(values.customerName);
  const [customerId, setCustomerId] = useState<string>(
    values.customerId === null ? '' : String(values.customerId),
  );

  const byId = useMemo(() => new Map(products.map((p) => [String(p.id), p])), [products]);

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }

  function chooseProduct(key: number, productId: string) {
    const product = byId.get(productId);
    updateLine(key, {
      productId,
      // Pre-filled with the shelf price, and freely editable: quoting is
      // negotiation, and a yard that could not offer a keener price than the
      // shelf would have no reason to write a quote at all.
      unitPrice: product ? (product.sellingPrice / 100).toFixed(2) : '',
    });
  }

  const totals = useMemo(() => {
    let subtotal = 0;
    let bad = false;
    for (const line of lines) {
      if (line.productId === '') continue;
      const qty = toMilli(line.qty);
      const price = toMinor(line.unitPrice);
      const discount = line.discount ? toMinor(line.discount) : 0;
      if (Number.isNaN(qty) || Number.isNaN(price) || Number.isNaN(discount)) {
        bad = true;
        continue;
      }
      subtotal += Math.round((price * qty) / 1000) - discount;
    }
    const off = quoteDiscount ? toMinor(quoteDiscount) : 0;
    return { subtotal, off: Number.isNaN(off) ? 0 : off, bad };
  }, [lines, quoteDiscount]);

  const fmt = (minorValue: number) =>
    `${currencyCode} ${(minorValue / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  /** What the server is actually given. Typed strings, parsed by the domain. */
  const payload = JSON.stringify(
    lines
      .filter((line) => line.productId !== '' && line.qty.trim() !== '')
      .map((line) => ({
        productId: Number(line.productId),
        qty: line.qty.trim(),
        unitPrice: line.unitPrice.trim() || '0',
        ...(line.discount.trim() ? { discount: line.discount.trim() } : {}),
      })),
  );

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {values.quotationId !== undefined && (
        <input type="hidden" name="quotationId" value={values.quotationId} />
      )}
      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="customerId" value={customerId} />

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Who it is for</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Customer"
            htmlFor="customerName"
            required
            hint="Type any name. They do not need to be on your customer list yet."
            error={state.fieldErrors?.['customerName']}
          >
            <TextInput
              id="customerName"
              name="customerName"
              value={customerName}
              onChange={(event) => {
                setCustomerName(event.target.value);
                // Typing a fresh name unlinks the picked customer, so the two
                // cannot end up naming different people on one quote.
                setCustomerId('');
              }}
              list="quote-customers"
              invalid={Boolean(state.fieldErrors?.['customerName'])}
            />
            <datalist id="quote-customers">
              {customers.map((customer) => (
                <option key={customer.id} value={customer.name} />
              ))}
            </datalist>
          </Field>

          <Field label="Phone" htmlFor="customerPhone">
            <TextInput
              id="customerPhone"
              name="customerPhone"
              type="tel"
              defaultValue={values.customerPhone}
            />
          </Field>

          <Field
            label="Job or site"
            htmlFor="reference"
            hint="Optional. “Adenta site”, “Block C roofing”."
          >
            <TextInput id="reference" name="reference" defaultValue={values.reference} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" htmlFor="businessDate" required>
              <DateField
                id="businessDate"
                name="businessDate"
                label="Quote date"
                defaultValue={values.businessDate}
              />
            </Field>
            <Field
              label="Valid until"
              htmlFor="validUntil"
              required
              error={state.fieldErrors?.['validUntil']}
            >
              <DateField
                id="validUntil"
                name="validUntil"
                label="Valid until"
                defaultValue={values.validUntil}
                invalid={Boolean(state.fieldErrors?.['validUntil'])}
              />
            </Field>
          </div>
        </div>

        <p className="mt-3 text-xs text-content-muted">
          After the valid-until date the quote can still be turned into a sale, but only if you say
          why. Prices move, and an old quote honoured without a second look is how stock is sold
          below what it now costs to replace.
        </p>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">What is being quoted</h2>
        {state.fieldErrors?.['lines'] && (
          <Alert tone="danger" className="mb-4">
            {state.fieldErrors['lines']}
          </Alert>
        )}

        <div className="space-y-3">
          {lines.map((line) => {
            const product = byId.get(line.productId);
            const qty = toMilli(line.qty);
            const price = toMinor(line.unitPrice);
            const discount = line.discount ? toMinor(line.discount) : 0;
            const broken = Number.isNaN(qty) || Number.isNaN(price) || Number.isNaN(discount);
            const lineTotal = broken ? 0 : Math.round((price * qty) / 1000) - discount;

            return (
              <div
                key={line.key}
                className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
              >
                <div>
                  <label
                    htmlFor={`product-${line.key}`}
                    className="mb-1 block text-xs text-content-muted"
                  >
                    Item
                  </label>
                  <select
                    id={`product-${line.key}`}
                    value={line.productId}
                    onChange={(event) => chooseProduct(line.key, event.target.value)}
                    className="h-10 w-full rounded-lg border border-line bg-surface-raised px-3 text-sm text-content"
                  >
                    <option value="">Choose…</option>
                    {products.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor={`qty-${line.key}`}
                    className="mb-1 block text-xs text-content-muted"
                  >
                    Qty {product ? `(${product.unit})` : ''}
                  </label>
                  <AmountInput
                    id={`qty-${line.key}`}
                    value={line.qty}
                    onChange={(event) => updateLine(line.key, { qty: event.target.value })}
                    invalid={Number.isNaN(qty) && line.qty.trim() !== ''}
                    className="h-10"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`price-${line.key}`}
                    className="mb-1 block text-xs text-content-muted"
                  >
                    Price
                  </label>
                  <AmountInput
                    id={`price-${line.key}`}
                    value={line.unitPrice}
                    onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })}
                    invalid={Number.isNaN(price)}
                    className="h-10"
                  />
                </div>

                <div>
                  <label
                    htmlFor={`disc-${line.key}`}
                    className="mb-1 block text-xs text-content-muted"
                  >
                    Less
                  </label>
                  <AmountInput
                    id={`disc-${line.key}`}
                    value={line.discount}
                    onChange={(event) => updateLine(line.key, { discount: event.target.value })}
                    className="h-10"
                  />
                </div>

                <div className="flex items-end justify-between gap-2 sm:flex-col sm:items-end">
                  <span className="tabular text-sm font-medium text-content">
                    {broken ? '—' : fmt(lineTotal)}
                  </span>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setLines((current) => current.filter((row) => row.key !== line.key))
                      }
                      className="text-xs font-medium text-danger hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={() =>
            setLines((current) => [
              ...current,
              {
                key: Math.max(0, ...current.map((row) => row.key)) + 1,
                productId: '',
                qty: '',
                unitPrice: '',
                discount: '',
              },
            ])
          }
        >
          Add item
        </Button>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Totals</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Discount on the whole quote" htmlFor="quoteDiscount">
            <AmountInput
              id="quoteDiscount"
              name="quoteDiscount"
              value={quoteDiscount}
              onChange={(event) => setQuoteDiscount(event.target.value)}
            />
          </Field>

          <dl className="space-y-2 self-end text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-content-muted">Items</dt>
              <dd className="tabular font-medium text-content">{fmt(totals.subtotal)}</dd>
            </div>
            {totals.off > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-content-muted">Less</dt>
                <dd className="tabular font-medium text-content">−{fmt(totals.off)}</dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
              <dt className="font-medium text-content">Before tax</dt>
              <dd className="tabular font-semibold text-content">
                {fmt(Math.max(0, totals.subtotal - totals.off))}
              </dd>
            </div>
          </dl>
        </div>

        {/*
          Said plainly rather than shown as a figure that might be wrong. Tax is
          worked out on the server from the components the shop actually charges,
          and guessing at it here would put a number on screen that the saved
          quote could contradict.
        */}
        <p className="mt-3 text-xs text-content-muted">
          Any tax the shop charges is added when the quote is saved, and appears on the printed
          copy.
        </p>

        <Field label="Notes" htmlFor="notes" hint="Anything the customer should read. Optional.">
          <TextInput id="notes" name="notes" defaultValue={values.notes} />
        </Field>
      </Card>

      <div className="flex items-center gap-3">
        <SaveButton label={submitLabel} />
        {totals.bad && (
          <span className="text-sm text-danger">Check the quantities and prices above.</span>
        )}
      </div>
    </form>
  );
}
