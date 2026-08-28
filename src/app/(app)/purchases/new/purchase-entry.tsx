'use client';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';

import { createPurchaseAction, type PurchaseFormState } from '@/actions/purchase.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, TextInput } from '@/components/ui/field';

export interface EntryProduct {
  id: number;
  name: string;
  unit: string;
  costPrice: number;
  qtyOnHandMilli: number;
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

interface Row {
  key: number;
  productId: string;
  qty: string;
  unitCost: string;
  discount: string;
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

function toMinor(text: string): number {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return 0;
  if (!/^\d*\.?\d{0,2}$/.test(trimmed)) return Number.NaN;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0') || '0');
}

function toMilli(text: string): number {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return 0;
  if (!/^\d*\.?\d{0,3}$/.test(trimmed)) return Number.NaN;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole || '0') * 1000 + Number(fraction.padEnd(3, '0') || '0');
}

function fmt(minorValue: number): string {
  const digits = Math.abs(Math.round(minorValue)).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minorValue < 0 ? '-' : ''}${whole}.${digits.slice(-2)}`;
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
}: {
  products: EntryProduct[];
  suppliers: EntrySupplier[];
  accounts: EntryAccount[];
  today: string;
  currencyCode: string;
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
  const [rows, setRows] = useState<Row[]>([
    { key: 1, productId: '', qty: '', unitCost: '', discount: '', expiryDate: '', showExpiry: false },
  ]);
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
    setRows([
      { key: 1, productId: '', qty: '', unitCost: '', discount: '', expiryDate: '', showExpiry: false },
    ]);
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
    setRows((current) => [
      ...current,
      {
        key: Math.max(0, ...current.map((row) => row.key)) + 1,
        productId: '',
        qty: '',
        unitCost: '',
        discount: '',
        expiryDate: '',
        showExpiry: false,
      },
    ]);
  }

  const totals = useMemo(() => {
    let subtotal = 0;
    let invalid = false;

    for (const row of rows) {
      if (row.productId === '' || row.qty.trim() === '') continue;
      const qty = toMilli(row.qty);
      const cost = toMinor(row.unitCost);
      const discount = row.discount ? toMinor(row.discount) : 0;
      if (Number.isNaN(qty) || Number.isNaN(cost) || Number.isNaN(discount)) {
        invalid = true;
        continue;
      }
      subtotal += Math.round((cost * qty) / 1000) - discount;
    }

    const discount = invoiceDiscount ? toMinor(invoiceDiscount) : 0;
    const total = Math.max(0, subtotal - (Number.isNaN(discount) ? 0 : discount));
    const paid = Number.isNaN(toMinor(payAmount)) ? 0 : toMinor(payAmount);

    return {
      subtotal,
      discount: Number.isNaN(discount) ? 0 : discount,
      total,
      paid,
      outstanding: Math.max(0, total - paid),
      overpaid: paid > total,
      invalid,
    };
  }, [rows, invoiceDiscount, payAmount]);

  const filledRows = rows.filter((row) => row.productId !== '' && row.qty.trim() !== '');
  const canSubmit =
    supplierId !== '' && filledRows.length > 0 && !totals.invalid && !totals.overpaid && !pending;

  const basket = JSON.stringify({
    supplierId: supplierId === '' ? 0 : Number(supplierId),
    businessDate,
    invoiceNo: invoiceNo.trim() || undefined,
    note: note.trim() || undefined,
    invoiceDiscount: invoiceDiscount.trim() || undefined,
    items: filledRows.map((row) => ({
      productId: Number(row.productId),
      qty: row.qty.trim(),
      unitCost: row.unitCost.trim() || '0',
      discount: row.discount.trim() || undefined,
      expiryDate: row.expiryDate.trim() || undefined,
    })),
    tenders:
      payAmount.trim() && payAccountId
        ? [
            {
              paymentAccountId: Number(payAccountId),
              amount: payAmount.trim(),
              reference: reference.trim() || undefined,
            },
          ]
        : [],
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
            <select
              id="supplier"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              <option value="">Choose a supplier…</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={String(supplier.id)}>
                  {supplier.name}
                  {supplier.balanceMinor > 0 ? ` — owed ${fmt(supplier.balanceMinor)}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="date" className="mb-1 block text-sm font-medium text-content">
              Date <span className="text-danger">*</span>
            </label>
            <TextInput
              id="date"
              type="date"
              value={businessDate}
              onChange={(event) => setBusinessDate(event.target.value)}
            />
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
            />
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">What arrived</h2>

        <div className="space-y-3">
          {rows.map((row, index) => {
            const product = products.find((item) => String(item.id) === row.productId);
            const qty = toMilli(row.qty);
            const cost = toMinor(row.unitCost);
            const discount = row.discount ? toMinor(row.discount) : 0;
            const lineTotal =
              Number.isNaN(qty) || Number.isNaN(cost) || Number.isNaN(discount)
                ? 0
                : Math.round((cost * qty) / 1000) - discount;

            return (
              <div key={row.key} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-12">
                <div className="sm:col-span-4">
                  <label
                    htmlFor={`p-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    Product
                  </label>
                  <select
                    id={`p-${row.key}`}
                    value={row.productId}
                    onChange={(event) => {
                      const chosen = products.find((p) => String(p.id) === event.target.value);
                      updateRow(row.key, {
                        productId: event.target.value,
                        // Pre-fill with the expected cost to save typing.
                        unitCost: row.unitCost || (chosen ? fmt(chosen.costPrice) : ''),
                      });
                    }}
                    className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
                  >
                    <option value="">Choose…</option>
                    {products.map((item) => (
                      <option key={item.id} value={String(item.id)}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor={`q-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    Quantity {product ? `(${product.unit})` : ''}
                  </label>
                  <AmountInput
                    id={`q-${row.key}`}
                    value={row.qty}
                    onChange={(event) => updateRow(row.key, { qty: event.target.value })}
                    invalid={Number.isNaN(qty)}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label
                    htmlFor={`c-${row.key}`}
                    className="mb-1 block text-xs font-medium text-content-muted"
                  >
                    Cost each
                  </label>
                  <AmountInput
                    id={`c-${row.key}`}
                    value={row.unitCost}
                    onChange={(event) => updateRow(row.key, { unitCost: event.target.value })}
                    invalid={Number.isNaN(cost)}
                  />
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
                  />
                </div>

                <div className="flex items-end justify-between gap-2 sm:col-span-2">
                  <span className="tabular text-sm font-semibold text-content">
                    {fmt(lineTotal)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
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
                          <TextInput
                            id={`e-${row.key}`}
                            type="date"
                            value={row.expiryDate}
                            onChange={(event) =>
                              updateRow(row.key, { expiryDate: event.target.value })
                            }
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
              <dd className="tabular text-content">{fmt(totals.subtotal)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-content-muted">Discount on the whole invoice</dt>
              <dd className="w-32">
                <AmountInput
                  value={invoiceDiscount}
                  onChange={(event) => setInvoiceDiscount(event.target.value)}
                  placeholder="0.00"
                  aria-label="Invoice discount"
                  className="h-9"
                />
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold">
              <dt className="text-content">Total</dt>
              <dd className="tabular text-content">
                {currencyCode} {fmt(totals.total)}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <h2 className="mb-3 text-sm font-semibold text-content">Payment</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="payAccount" className="mb-1 block text-xs text-content-muted">
                Paid from
              </label>
              <select
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
              </select>
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
                  invalid={totals.overpaid}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPayAmount(fmt(totals.total))}
                  disabled={totals.total === 0}
                >
                  All
                </Button>
              </div>
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
              />
            </div>
          </div>

          <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-content-muted">Paid</dt>
              <dd className="tabular text-content">{fmt(totals.paid)}</dd>
            </div>
            {totals.outstanding > 0 && (
              <div className="flex justify-between text-base font-semibold">
                <dt className="text-warning">Still owed to supplier</dt>
                <dd className="tabular text-warning">{fmt(totals.outstanding)}</dd>
              </div>
            )}
          </dl>

          {totals.overpaid && (
            <Alert tone="danger" className="mt-3">
              You cannot pay more than the purchase total.
            </Alert>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="lg" disabled={!canSubmit}>
          {pending ? 'Saving…' : `Save purchase — ${currencyCode} ${fmt(totals.total)}`}
        </Button>
        <Link href="/purchases">
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
