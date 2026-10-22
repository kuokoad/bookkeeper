'use client';

import { Select } from '@/components/ui/select';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';

import { createPurchaseAction, type PurchaseFormState } from '@/actions/purchase.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';
import { unitLabel, UnitPicker } from '@/components/shared/unit-picker';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { addDays } from '@/domain/business-date';
import { toDecimalString, toInputString, type Minor } from '@/domain/money';
import type { TaxComponent } from '@/domain/tax/components';
import {
  purchaseBasket,
  readPurchase,
  type LineEntry,
  type LineProduct,
  type PurchaseReading,
} from './read-purchase';

export interface EntryProduct extends LineProduct {
  name: string;
  costPrice: number;
  /** Per alternate unit. Null when there is no alternate. */
  altCostPrice: number | null;
  qtyOnHandMilli: number;
  /** False for a service like cartage: free goods do nothing to an average cost there. */
  trackInventory: boolean;
}

export interface EntrySupplier {
  id: number;
  name: string;
  balanceMinor: number;
}

export interface EntryAccount {
  id: number;
  name: string;
  isDefault: boolean;
}

interface Row extends LineEntry {
  key: number;
  /**
   * True while the cost is the one the form filled in from the catalog, so it
   * may follow a change of product or unit. A cost somebody typed is theirs and
   * stays.
   */
  costFilled: boolean;
  /**
   * The product and unit the figure in the cost box is for ('' when it was
   * typed before a product was chosen). A typed cost is kept when either
   * changes, so when they differ from the line's the line says so, instead of
   * quietly reading 3.20 a tin as 3.20 a Carton, or Milk's price as Rice's.
   */
  costFor: string;
  costAlt: boolean;
  /**
   * When these goods run out, 'YYYY-MM-DD', or '' for goods that do not.
   *
   * Hidden behind a link rather than sitting on every line, because most lines
   * in most shops are rice and soap and nobody should be asked a question about
   * those. A field that is present gets filled in, and a wrong date at the till
   * is worse than no date at all.
   */
  expiryDate: string;
  showExpiry: boolean;
}

function blankRow(key: number): Row {
  return {
    key,
    productId: '',
    qty: '',
    alt: false,
    unitCost: '',
    costFilled: false,
    costFor: '',
    costAlt: false,
    discount: '',
    expiryDate: '',
    showExpiry: false,
  };
}

/**
 * The catalog cost to pre-fill, or nothing.
 *
 * Never a 0.00: a product or carton with no cost on file used to fill the box
 * with one, which looked typed and saved the stock at no cost.
 */
function catalogCost(product: EntryProduct | undefined, alt: boolean): string {
  const cost = product ? (alt ? product.altCostPrice : product.costPrice) : null;
  return cost !== null && cost > 0 ? toInputString(cost as Minor) : '';
}

/** Whether any one box, rather than the purchase as a whole, is refused. */
function fieldRefused(reading: PurchaseReading): boolean {
  return (
    reading.lines.some((line) => Object.keys(line.errors).length > 0) ||
    [
      reading.dateError,
      reading.invoiceNoError,
      reading.invoiceDiscountError,
      reading.paidError,
      reading.referenceError,
    ].some((error) => error !== undefined)
  );
}

/** Why a field is red, where `aria-describedby` on that field points. */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger">
      {message}
    </p>
  );
}

/**
 * Recording a delivery.
 *
 * Follows the same shape as the POS but in reverse: choose the supplier, list
 * what arrived and what it cost, record what was paid, and see immediately how
 * much is still owed.
 */
export function PurchaseEntry({
  products,
  suppliers,
  accounts,
  today,
  currencyCode,
  offerExpiry,
  taxComponents,
  lockedBefore,
}: {
  products: EntryProduct[];
  suppliers: EntrySupplier[];
  accounts: EntryAccount[];
  today: string;
  currencyCode: string;
  /** The shop's taxes, which the server adds on top of every purchase. */
  taxComponents: TaxComponent[];
  /** The books lock: a delivery dated on or before it is refused. */
  lockedBefore: string | null;
  /**
   * Whether to OFFER a date on a delivery. A shop selling pipes has no use for
   * one. It only hides the button below: a row that already carries a date
   * still shows it, so an entry in progress is never quietly stripped.
   */
  offerExpiry: boolean;
}) {
  const [state, formAction, pending] = useActionState<PurchaseFormState, FormData>(
    createPurchaseAction,
    {},
  );

  const [supplierId, setSupplierId] = useState('');
  const [businessDate, setBusinessDate] = useState(today);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [note, setNote] = useState('');
  const [invoiceDiscount, setInvoiceDiscount] = useState('');
  const [rows, setRows] = useState<Row[]>([blankRow(1)]);
  const [payAccountId, setPayAccountId] = useState(
    String(accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? ''),
  );
  const [payAmount, setPayAmount] = useState('');
  const [reference, setReference] = useState('');

  // Reset after a saved purchase, using React's render-phase adjustment rather
  // than an effect (which would cause a cascading render).
  const [handled, setHandled] = useState<string | undefined>(undefined);
  if (state.purchaseNo && state.purchaseNo !== handled) {
    setHandled(state.purchaseNo);
    setRows([blankRow(1)]);
    setInvoiceNo('');
    setNote('');
    setInvoiceDiscount('');
    setPayAmount('');
    setReference('');
  }

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [...current, blankRow(Math.max(0, ...current.map((row) => row.key)) + 1)]);
  }

  const productsById = useMemo(
    () => new Map(products.map((product) => [String(product.id), product])),
    [products],
  );

  const reading = useMemo(
    () =>
      readPurchase({
        rows,
        products,
        invoiceDiscount,
        payAmount,
        canPay: payAccountId !== '',
        taxComponents,
        businessDate,
        lockedBefore,
        invoiceNo,
        reference,
      }),
    [
      rows,
      products,
      invoiceDiscount,
      payAmount,
      payAccountId,
      taxComponents,
      businessDate,
      lockedBefore,
      invoiceNo,
      reference,
    ],
  );

  /** Why Save is not offered yet, said beside it rather than left to be guessed. */
  const blocker =
    supplierId === ''
      ? 'Choose a supplier.'
      : reading.filled === 0
        ? 'Add what arrived.'
        : !reading.acceptable
          ? // A refusal of the whole purchase, such as 0.00, is no one entry's,
            // so it is named here unless an entry also has something to fix.
            (fieldRefused(reading) ? undefined : reading.totalError) ??
            'Correct the entries that have a message under them.'
          : null;
  const canSubmit = blocker === null && !pending;

  const basket = purchaseBasket({
    supplierId,
    businessDate,
    invoiceNo,
    note,
    invoiceDiscount,
    rows,
    lines: reading.lines,
    payAccountId,
    payAmount,
    reference,
  });

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="basket" value={basket} />

      {state.purchaseNo && (
        <Alert tone="success" title={`Purchase saved — ${state.purchaseNo}`}>
          Stock was added and the accounts updated.{' '}
          <Link href={`/purchases/${state.purchaseId}`} className="text-accent hover:underline">
            View it
          </Link>
        </Alert>
      )}
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="supplier" className="mb-1 block text-sm font-medium text-content">
              Supplier <span className="text-danger">*</span>
            </label>
            <Select
              id="supplier"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              <option value="">Choose a supplier…</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={String(supplier.id)}>
                  {supplier.name}
                  {supplier.balanceMinor > 0
                    ? ` — owed ${toDecimalString(supplier.balanceMinor as Minor)}`
                    : ''}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="date" className="mb-1 block text-sm font-medium text-content">
              Date <span className="text-danger">*</span>
            </label>
            <DateField
              id="date"
              label="Delivery date"
              value={businessDate}
              onChange={setBusinessDate}
              today={today}
              invalid={reading.dateError !== undefined}
              describedBy={reading.dateError ? 'date-error' : undefined}
              min={lockedBefore ? addDays(lockedBefore, 1) : undefined}
              minReason={
                lockedBefore ? `The books are closed up to ${formatDate(lockedBefore)}.` : undefined
              }
            />
            <FieldError id="date" message={reading.dateError} />
          </div>

          <div>
            <label htmlFor="invoiceNo" className="mb-1 block text-sm font-medium text-content">
              Their invoice no.
            </label>
            <TextInput
              id="invoiceNo"
              value={invoiceNo}
              onChange={(event) => setInvoiceNo(event.target.value)}
              placeholder="Optional"
              invalid={reading.invoiceNoError !== undefined}
            />
            <FieldError id="invoiceNo" message={reading.invoiceNoError} />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">What arrived</h2>

        <div className="space-y-3">
          {rows.map((row, index) => {
            const product = productsById.get(row.productId);
            const line = reading.lines[index];
            const errors = line?.errors ?? {};
            // A typed cost kept across a change of product or unit is for the
            // other one, until somebody looks at it.
            const typedCost = !row.costFilled && row.unitCost.trim() !== '';
            const costProduct =
              typedCost && row.costFor !== '' && row.costFor !== row.productId
                ? productsById.get(row.costFor)
                : undefined;
            const costUnitChanged =
              typedCost &&
              costProduct === undefined &&
              product !== undefined &&
              unitLabel(row.costAlt, product) !== unitLabel(row.alt, product);
            const costNotes = [
              line?.free ? `c-${row.key}-free` : null,
              costProduct ? `c-${row.key}-product` : null,
              costUnitChanged ? `c-${row.key}-unit` : null,
            ].filter((id) => id !== null);

            return (
              <div key={row.key} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <label
                    htmlFor={`p-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    Product
                  </label>
                  <Select
                    id={`p-${row.key}`}
                    value={row.productId}
                    onChange={(event) => {
                      const chosen = productsById.get(event.target.value);
                      updateRow(row.key, {
                        productId: event.target.value,
                        alt: false,
                        // Pre-fill with the expected cost to save typing.
                        ...(row.costFilled || row.unitCost.trim() === ''
                          ? {
                              unitCost: catalogCost(chosen, false),
                              costFilled: true,
                              costFor: event.target.value,
                              costAlt: false,
                            }
                          : // A cost typed before any product was chosen
                            // belongs to the first one chosen.
                            { costFor: row.costFor || row.productId || event.target.value }),
                      });
                    }}
                    aria-invalid={errors.product ? true : undefined}
                    aria-describedby={errors.product ? `p-${row.key}-error` : undefined}
                    className={cn(
                      'h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content',
                      errors.product && 'border-danger',
                    )}
                  >
                    <option value="">Choose…</option>
                    {products.map((item) => (
                      <option key={item.id} value={String(item.id)}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                  <FieldError id={`p-${row.key}`} message={errors.product} />
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor={`q-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    Quantity {product ? `(${unitLabel(row.alt, product)})` : ''}
                  </label>
                  <AmountInput
                    id={`q-${row.key}`}
                    value={row.qty}
                    onChange={(event) => updateRow(row.key, { qty: event.target.value })}
                    invalid={errors.qty !== undefined}
                  />
                  <FieldError id={`q-${row.key}`} message={errors.qty} />
                  {product?.altUnit && (
                    <div className="mt-1">
                      <UnitPicker
                        id={`u-${row.key}`}
                        alt={row.alt}
                        units={product}
                        onChange={(alt) =>
                          // The expected cost follows the unit: a carton costs a
                          // carton's worth. A typed cost stays, and is flagged below.
                          updateRow(row.key, {
                            alt,
                            ...(row.costFilled || row.unitCost.trim() === ''
                              ? {
                                  unitCost: catalogCost(product, alt),
                                  costFilled: true,
                                  costFor: row.productId,
                                  costAlt: alt,
                                }
                              : {}),
                          })
                        }
                      />
                    </div>
                  )}
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor={`c-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    {product ? `Cost per ${unitLabel(row.alt, product)}` : 'Cost each'}
                  </label>
                  <AmountInput
                    id={`c-${row.key}`}
                    value={row.unitCost}
                    onChange={(event) =>
                      updateRow(row.key, {
                        unitCost: event.target.value,
                        costFilled: false,
                        costFor: row.productId,
                        costAlt: row.alt,
                      })
                    }
                    invalid={errors.cost !== undefined}
                    {...(errors.cost === undefined && costNotes.length > 0
                      ? { 'aria-describedby': costNotes.join(' ') }
                      : {})}
                  />
                  <FieldError id={`c-${row.key}`} message={errors.cost} />
                  {line?.free && (
                    /**
                     * A line that comes to 0.00 is free goods: a sample, the
                     * thirteenth tin of a baker's dozen. Allowed, but said
                     * out loud, because it pulls the product's average cost
                     * down and every later sale's profit up.
                     */
                    <p id={`c-${row.key}-free`} className="mt-1 text-xs font-medium text-warning">
                      {product?.trackInventory === false
                        ? 'Free: nothing is charged for this line.'
                        : 'Free goods. These bring the average cost down.'}
                    </p>
                  )}
                  {costProduct && (
                    <p id={`c-${row.key}-product`} className="mt-1 text-xs font-medium text-warning">
                      Check this cost: it was typed for {costProduct.name}.
                    </p>
                  )}
                  {costUnitChanged && product && (
                    <p id={`c-${row.key}-unit`} className="mt-1 text-xs font-medium text-warning">
                      Check this cost: it was typed per {unitLabel(row.costAlt, product)}, and the line
                      is now per {unitLabel(row.alt, product)}.
                    </p>
                  )}
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor={`d-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    Discount
                  </label>
                  <AmountInput
                    id={`d-${row.key}`}
                    value={row.discount}
                    onChange={(event) => updateRow(row.key, { discount: event.target.value })}
                    placeholder="0.00"
                    invalid={errors.discount !== undefined}
                  />
                  <FieldError id={`d-${row.key}`} message={errors.discount} />
                </div>

                <div className="flex items-start justify-between gap-2 sm:col-span-2">
                  <div>
                    <span className="mb-1 block text-xs font-medium text-content-muted">
                      Line total
                    </span>
                    <span className="tabular flex h-11 items-center text-sm font-semibold text-content">
                      {line === undefined || line.total === null ? '—' : toDecimalString(line.total)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-6"
                    onClick={() =>
                      setRows((current) =>
                        current.length === 1 ? current : current.filter((r) => r.key !== row.key),
                      )
                    }
                    disabled={rows.length === 1}
                    aria-label={`Remove line ${index + 1}`}
                  >
                    ✕
                  </Button>
                </div>

                {row.productId !== '' && (
                  <div className="sm:col-span-12">
                    {row.showExpiry || row.expiryDate !== '' ? (
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-44">
                          <label
                            htmlFor={`e-${row.key}`}
                            className="mb-1 block text-xs font-medium text-content-muted"
                          >
                            Expires
                          </label>
                          <DateField
                            id={`e-${row.key}`}
                            label="Expires"
                            value={row.expiryDate}
                            onChange={(next) => updateRow(row.key, { expiryDate: next })}
                            today={today}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            updateRow(row.key, { expiryDate: '', showExpiry: false })
                          }
                        >
                          No date
                        </Button>
                        {row.expiryDate !== '' && row.expiryDate < businessDate && (
                          /**
                           * The mistyped year, caught here rather than at the
                           * counter. Goods dated before the day they arrived
                           * are expired the moment they are saved, and the till
                           * would refuse to sell them — which is how staff
                           * learn to sell off-system.
                           */
                          <p className="text-xs font-medium text-warning">
                            That date has already passed — these goods will count as expired.
                          </p>
                        )}
                      </div>
                    ) : offerExpiry ? (
                      <button
                        type="button"
                        onClick={() => updateRow(row.key, { showExpiry: true })}
                        className="text-xs font-medium text-accent hover:underline"
                      >
                        + Expiry date
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" onClick={addRow}>
            Add another line
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <h2 className="mb-3 text-sm font-semibold text-content">Totals</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-content-muted">Subtotal</dt>
              <dd className="tabular text-content">
                {reading.subtotal === null ? '—' : toDecimalString(reading.subtotal)}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="pt-2 text-content-muted">Discount on the whole invoice</dt>
              <dd className="w-40 text-right">
                <AmountInput
                  id="invoiceDiscount"
                  value={invoiceDiscount}
                  onChange={(event) => setInvoiceDiscount(event.target.value)}
                  placeholder="0.00"
                  aria-label="Invoice discount"
                  className="h-9"
                  invalid={reading.invoiceDiscountError !== undefined}
                />
                <FieldError id="invoiceDiscount" message={reading.invoiceDiscountError} />
              </dd>
            </div>
            {reading.total === null
              ? // The taxes still apply while the total cannot be worked out, so
                // their rows stay, with a dash, rather than vanish and come back.
                taxComponents
                  .filter((tax) => tax.rateBp > 0)
                  .map((tax) => (
                    <div key={tax.code} className="flex justify-between">
                      <dt className="text-content-muted">{tax.name}</dt>
                      <dd className="tabular text-content">—</dd>
                    </div>
                  ))
              : reading.taxLines.map(
                  (tax) =>
                    tax.amount !== 0 && (
                      <div key={tax.code} className="flex justify-between">
                        <dt className="text-content-muted">{tax.name}</dt>
                        <dd className="tabular text-content">{toDecimalString(tax.amount)}</dd>
                      </div>
                    ),
                )}
            <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold">
              <dt className="text-content">Total</dt>
              <dd className="tabular text-content">
                {reading.total === null ? '—' : `${currencyCode} ${toDecimalString(reading.total)}`}
              </dd>
            </div>
          </dl>
          {reading.totalError && (
            <p id="total-error" className="mt-1.5 text-right text-xs font-medium text-danger">
              {reading.totalError}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <h2 className="mb-3 text-sm font-semibold text-content">Payment</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="payAccount" className="mb-1 block text-xs text-content-muted">
                Paid from
              </label>
              <Select
                id="payAccount"
                value={payAccountId}
                onChange={(event) => setPayAccountId(event.target.value)}
                className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={String(account.id)}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="payAmount" className="mb-1 block text-xs text-content-muted">
                Amount paid now
              </label>
              <div className="flex gap-2">
                <AmountInput
                  id="payAmount"
                  value={payAmount}
                  onChange={(event) => setPayAmount(event.target.value)}
                  placeholder="0.00"
                  invalid={reading.paidError !== undefined}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => reading.total !== null && setPayAmount(toInputString(reading.total))}
                  disabled={reading.total === null || reading.total === 0}
                >
                  All
                </Button>
              </div>
              <FieldError id="payAmount" message={reading.paidError} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="ref" className="mb-1 block text-xs text-content-muted">
                Reference
              </label>
              <TextInput
                id="ref"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Optional"
                className="h-10"
                invalid={reading.referenceError !== undefined}
              />
              <FieldError id="ref" message={reading.referenceError} />
            </div>
          </div>

          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-content-muted">Paid</dt>
              <dd className="tabular text-content">
                {reading.paid === null ? '—' : toDecimalString(reading.paid)}
              </dd>
            </div>
            {reading.outstanding !== null && reading.outstanding > 0 && (
              <div className="flex justify-between text-base font-semibold">
                <dt className="text-warning">Still owed to supplier</dt>
                <dd className="tabular text-warning">{toDecimalString(reading.outstanding)}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="lg"
          disabled={!canSubmit}
          aria-describedby={blocker && !pending ? 'save-reason' : undefined}
        >
          {pending
            ? 'Saving…'
            : reading.total === null
              ? 'Save purchase'
              : `Save purchase — ${currencyCode} ${toDecimalString(reading.total)}`}
        </Button>
        <Link href="/purchases">
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
        {blocker && !pending && (
          <p id="save-reason" className="text-sm text-content-muted">
            {blocker}
          </p>
        )}
      </div>
    </form>
  );
}
