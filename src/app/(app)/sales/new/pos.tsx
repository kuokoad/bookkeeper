'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';

import { createSaleAction, type SaleFormState } from '@/actions/sale.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, TextInput } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { minor } from '@/domain/money';
import {
  taxOnNet,
  taxWithinGross,
  type TaxComponent,
  type TaxLine,
} from '@/domain/tax/components';

export interface PosProduct {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  /** Minor units. */
  sellingPrice: number;
  qtyOnHandMilli: number;
  trackInventory: boolean;
}

export interface PosCustomer {
  id: number;
  name: string;
  balanceMinor: number;
}

export interface PosAccount {
  id: number;
  name: string;
  kind: string;
  isDefault: boolean;
}

interface CartLine {
  key: number;
  productId: number;
  name: string;
  unit: string;
  qty: string;
  unitPrice: string;
  discount: string;
  qtyOnHandMilli: number;
  trackInventory: boolean;
}

// --- money helpers (display only; the server recomputes everything) --------

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
  const negative = minorValue < 0;
  const digits = Math.abs(Math.round(minorValue)).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

function fmtQty(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const fraction = Math.abs(milli % 1000)
    .toString()
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * The point-of-sale screen.
 *
 * Optimised for speed: the whole active catalogue is loaded once, so search and
 * barcode matching are instant and work with no network round-trip. Totals are
 * shown live using the same arithmetic rules as the server, but the server
 * recomputes every figure from its own prices before anything is saved.
 */
export function Pos({
  products,
  customers,
  accounts,
  today,
  currencyCode,
  taxComponents,
  taxInclusive,
  mayOverridePrice,
  cartSeed,
}: {
  products: PosProduct[];
  customers: PosCustomer[];
  accounts: PosAccount[];
  today: string;
  currencyCode: string;
  taxComponents: TaxComponent[];
  taxInclusive: boolean;
  /**
   * Whether this person may sell at anything other than the shop's own price.
   * Hiding the fields is a courtesy so nobody types a discount that is then
   * refused — `createSale` makes the actual decision, from the same right.
   */
  mayOverridePrice: boolean;
  /**
   * Random, generated once per page load ON THE SERVER. Two tills opening this
   * screen must never arrive at the same cart name, or one would be handed the
   * other's receipt instead of making its own sale.
   */
  cartSeed: string;
}) {
  const [state, formAction, pending] = useActionState<SaleFormState, FormData>(
    createSaleAction,
    {},
  );

  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState<string>('');
  const [invoiceDiscount, setInvoiceDiscount] = useState('');
  const [note, setNote] = useState('');
  const [tenderAccountId, setTenderAccountId] = useState<string>(
    String(accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? ''),
  );
  const [tenderAmount, setTenderAmount] = useState('');
  const [secondAccountId, setSecondAccountId] = useState<string>('');
  const [secondAmount, setSecondAmount] = useState('');
  const [reference, setReference] = useState('');

  const searchRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(1);

  /**
   * How many sales this page has completed. With `cartSeed` it names the cart,
   * so the server can tell a retry from a second sale.
   *
   * The random half comes from the server, once per page load, for two reasons.
   * Inventing it here would differ between the server render and the browser's,
   * which is a hydration mismatch; and `crypto.randomUUID` is unavailable
   * outside a secure context anyway — which is exactly how this app is meant to
   * run, on plain HTTP over a shop's own network. The counter is what makes the
   * next sale a new cart rather than a retry of the last one.
   */
  const [salesCompleted, setSalesCompleted] = useState(0);
  const cartRef = `${cartSeed}-${salesCompleted}`;

  // --- search ------------------------------------------------------------
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term === '') return [];
    return products
      .filter(
        (product) =>
          product.name.toLowerCase().includes(term) ||
          (product.sku ?? '').toLowerCase().includes(term) ||
          (product.barcode ?? '').toLowerCase().includes(term),
      )
      .slice(0, 8);
  }, [search, products]);

  function addProduct(product: PosProduct) {
    setLines((current) => {
      const existing = current.find((line) => line.productId === product.id);
      if (existing) {
        // Scanning the same item again bumps the quantity, as a till should.
        return current.map((line) =>
          line.productId === product.id
            ? { ...line, qty: String((toMilli(line.qty) + 1000) / 1000) }
            : line,
        );
      }
      return [
        ...current,
        {
          key: nextKey.current++,
          productId: product.id,
          name: product.name,
          unit: product.unit,
          qty: '1',
          unitPrice: fmt(product.sellingPrice),
          discount: '',
          qtyOnHandMilli: product.qtyOnHandMilli,
          trackInventory: product.trackInventory,
        },
      ];
    });
    setSearch('');
    searchRef.current?.focus();
  }

  /** A barcode scanner types fast and presses Enter — treat an exact hit as a scan. */
  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const term = search.trim().toLowerCase();
    if (term === '') return;

    const exact = products.find(
      (product) =>
        (product.barcode ?? '').toLowerCase() === term ||
        (product.sku ?? '').toLowerCase() === term,
    );
    const chosen = exact ?? matches[0];
    if (chosen) addProduct(chosen);
  }

  function updateLine(key: number, patch: Partial<CartLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function removeLine(key: number) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  function clearSale() {
    setLines([]);
    setInvoiceDiscount('');
    setNote('');
    setTenderAmount('');
    setSecondAmount('');
    setSecondAccountId('');
    setReference('');
    setCustomerId('');
    setSearch('');
    searchRef.current?.focus();
  }

  // --- live totals -------------------------------------------------------
  const totals = useMemo(() => {
    let subtotal = 0;
    let invalid = false;

    for (const line of lines) {
      const qty = toMilli(line.qty);
      const price = toMinor(line.unitPrice);
      const discount = line.discount ? toMinor(line.discount) : 0;
      if (Number.isNaN(qty) || Number.isNaN(price) || Number.isNaN(discount)) {
        invalid = true;
        continue;
      }
      subtotal += Math.round((price * qty) / 1000) - discount;
    }

    const discount = invoiceDiscount ? toMinor(invoiceDiscount) : 0;
    const net = Math.max(0, subtotal - (Number.isNaN(discount) ? 0 : discount));
    /**
     * Priced by the SAME domain functions the server uses, not by a second
     * implementation of the arithmetic here. Ghana charges three taxes on one
     * sale and the customer has to see each; more to the point, a till that
     * quotes one figure while the ledger records another is how a shop starts
     * arguing with its own receipts.
     */
    let taxLines: TaxLine[] = [];
    let tax = 0;
    try {
      const breakdown = taxInclusive
        ? taxWithinGross(minor(net), taxComponents)
        : taxOnNet(minor(net), taxComponents);
      taxLines = breakdown.lines;
      tax = breakdown.total;
    } catch {
      // A half-typed amount is not a crash. The server is the authority and
      // will refuse it too; here it just means the preview is not ready.
      invalid = true;
    }
    const total = taxInclusive ? net : net + tax;

    const tendered =
      (Number.isNaN(toMinor(tenderAmount)) ? 0 : toMinor(tenderAmount)) +
      (Number.isNaN(toMinor(secondAmount)) ? 0 : toMinor(secondAmount));

    return {
      subtotal,
      discount: Number.isNaN(discount) ? 0 : discount,
      taxLines,
      tax,
      total,
      tendered,
      change: Math.max(0, tendered - total),
      outstanding: Math.max(0, total - tendered),
      invalid,
    };
  }, [lines, invoiceDiscount, tenderAmount, secondAmount, taxComponents, taxInclusive]);

  const overselling = lines.filter(
    (line) => line.trackInventory && toMilli(line.qty) > line.qtyOnHandMilli,
  );
  const needsCustomer = totals.outstanding > 0 && customerId === '';
  const canSubmit =
    lines.length > 0 && !totals.invalid && !needsCustomer && !pending;

  // Clear the cart once a sale has been saved.
  //
  // Adjusting state during render (rather than in an effect) is React's
  // documented pattern for reacting to a changed input: it re-renders
  // immediately without committing the stale cart to the DOM first, and avoids
  // the cascading render an effect would cause.
  const [handledReceipt, setHandledReceipt] = useState<string | undefined>(undefined);
  if (state.receiptNo && state.receiptNo !== handledReceipt) {
    setHandledReceipt(state.receiptNo);
    setLines([]);
    setInvoiceDiscount('');
    setNote('');
    setTenderAmount('');
    setSecondAmount('');
    setSecondAccountId('');
    setReference('');
    setCustomerId('');
    setSearch('');
    // A new cart needs a new name, or the next sale would be read as a retry of
    // this one and quietly hand back this receipt again.
    setSalesCompleted((completed) => completed + 1);
  }

  /**
   * Put the cursor back in the search box once a sale has been saved.
   *
   * A barcode scanner is a keyboard. With focus left on the document body its
   * keystrokes go nowhere, so serving the next customer began with a mouse
   * click into the search box — on every sale, all day. `Clear` already put it
   * back; finishing a sale, which happens far more often, did not.
   *
   * It has to be an effect rather than part of the block above: the cart is
   * cleared DURING render, and the input cannot be focused until React has
   * committed that. Focusing a DOM node is synchronising with something outside
   * React, which is what an effect is for.
   *
   * Guarded on a sale having happened, so it never fights the `autoFocus` on
   * the input itself, and never steals the cursor from somebody who has clicked
   * elsewhere before ringing anything up.
   */
  useEffect(() => {
    if (handledReceipt !== undefined) searchRef.current?.focus();
  }, [handledReceipt]);

  const cartPayload = JSON.stringify({
    clientRef: cartRef,
    businessDate: today,
    customerId: customerId === '' ? null : Number(customerId),
    note: note.trim() || undefined,
    invoiceDiscount: invoiceDiscount.trim() || undefined,
    items: lines.map((line) => ({
      productId: line.productId,
      qty: line.qty.trim(),
      unitPrice: line.unitPrice.trim(),
      discount: line.discount.trim() || undefined,
    })),
    tenders: [
      ...(tenderAmount.trim() && tenderAccountId
        ? [
            {
              paymentAccountId: Number(tenderAccountId),
              amount: tenderAmount.trim(),
              reference: reference.trim() || undefined,
            },
          ]
        : []),
      ...(secondAmount.trim() && secondAccountId
        ? [{ paymentAccountId: Number(secondAccountId), amount: secondAmount.trim() }]
        : []),
    ],
  });

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      {/* ---------------- left: catalogue + cart ---------------- */}
      <div className="space-y-4 lg:col-span-3">
        {state.receiptNo && (
          <Alert tone="success" title={`Sale saved — ${state.receiptNo}`}>
            {state.changeMinor && state.changeMinor > 0 ? (
              <p className="text-base font-semibold text-content">
                Give change: {currencyCode} {fmt(state.changeMinor)}
              </p>
            ) : (
              <p>Payment received in full.</p>
            )}
            <p className="mt-2">
              <Link href={`/sales/${state.saleId}`} className="text-accent hover:underline">
                View receipt
              </Link>
            </p>
          </Alert>
        )}

        {state.error && <Alert tone="danger">{state.error}</Alert>}

        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <label htmlFor="pos-search" className="mb-1.5 block text-sm font-medium text-content">
            Find a product
          </label>
          <TextInput
            id="pos-search"
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Type a name, or scan a barcode"
            autoComplete="off"
            autoFocus
            className="h-12 text-base"
          />

          {matches.length > 0 && (
            <ul className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line">
              {matches.map((product) => {
                const out = product.trackInventory && product.qtyOnHandMilli <= 0;
                return (
                  <li key={product.id}>
                    <button
                      type="button"
                      onClick={() => addProduct(product)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-sunken"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-content">
                          {product.name}
                        </span>
                        <span className="block text-xs text-content-subtle">
                          {product.trackInventory
                            ? `${fmtQty(product.qtyOnHandMilli)} ${product.unit} in stock`
                            : 'Not stock-tracked'}
                          {product.sku ? ` · ${product.sku}` : ''}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {out && <Badge tone="danger">Out</Badge>}
                        <span className="tabular font-semibold text-content">
                          {fmt(product.sellingPrice)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface-raised">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-content">
              Cart {lines.length > 0 && `(${lines.length})`}
            </h2>
            {lines.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={clearSale}>
                Clear
              </Button>
            )}
          </div>

          {lines.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-content-muted">
              Search above to add the first item.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {lines.map((line) => {
                const qtyMilli = toMilli(line.qty);
                const price = toMinor(line.unitPrice);
                const discount = line.discount ? toMinor(line.discount) : 0;
                const bad = Number.isNaN(qtyMilli) || Number.isNaN(price) || Number.isNaN(discount);
                const lineTotal = bad ? 0 : Math.round((price * qtyMilli) / 1000) - discount;
                const short = line.trackInventory && qtyMilli > line.qtyOnHandMilli;

                return (
                  <li key={line.key} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-content">{line.name}</p>
                        <p className="text-xs text-content-subtle">
                          {fmtQty(line.qtyOnHandMilli)} {line.unit} in stock
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="tabular font-semibold text-content">{fmt(lineTotal)}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeLine(line.key)}
                          aria-label={`Remove ${line.name}`}
                        >
                          ✕
                        </Button>
                      </div>
                    </div>

                    <div
                      className={cn(
                        'mt-2 grid gap-2',
                        mayOverridePrice ? 'grid-cols-3' : 'grid-cols-2',
                      )}
                    >
                      <div>
                        <label
                          htmlFor={`qty-${line.key}`}
                          className="mb-1 block text-xs text-content-muted"
                        >
                          Qty ({line.unit})
                        </label>
                        <AmountInput
                          id={`qty-${line.key}`}
                          value={line.qty}
                          onChange={(event) => updateLine(line.key, { qty: event.target.value })}
                          invalid={Number.isNaN(qtyMilli) || short}
                          className="h-10"
                        />
                      </div>
                      <div>
                        {/*
                          Somebody who may not change the price is shown the
                          price, not a box that refuses to take one. A read-only
                          input still accepts focus, so it gave a cursor and a
                          focus ring and then silently ignored what was typed —
                          which reads as a broken till rather than a locked one,
                          and the only explanation was a tooltip no touch screen
                          ever shows. There is nothing to interact with here, so
                          nothing here is a control.

                          The submitted value comes from `lines` either way; the
                          input was never what carried it.
                        */}
                        {mayOverridePrice ? (
                          <>
                            <label
                              htmlFor={`price-${line.key}`}
                              className="mb-1 block text-xs text-content-muted"
                            >
                              Price
                            </label>
                            <AmountInput
                              id={`price-${line.key}`}
                              value={line.unitPrice}
                              onChange={(event) =>
                                updateLine(line.key, { unitPrice: event.target.value })
                              }
                              invalid={Number.isNaN(price)}
                              className="h-10"
                            />
                          </>
                        ) : (
                          <>
                            <p className="mb-1 text-xs text-content-muted">Price</p>
                            <p className="tabular flex h-10 items-center justify-end rounded-lg bg-surface-sunken px-3 text-content-muted">
                              {line.unitPrice}
                            </p>
                          </>
                        )}
                      </div>
                      {mayOverridePrice && (
                        <div>
                          <label
                            htmlFor={`disc-${line.key}`}
                            className="mb-1 block text-xs text-content-muted"
                          >
                            Discount
                          </label>
                          <AmountInput
                            id={`disc-${line.key}`}
                            value={line.discount}
                            onChange={(event) =>
                              updateLine(line.key, { discount: event.target.value })
                            }
                            placeholder="0.00"
                            className="h-10"
                          />
                        </div>
                      )}
                    </div>

                    {short && (
                      <p className="mt-1.5 text-xs font-medium text-warning">
                        Only {fmtQty(line.qtyOnHandMilli)} {line.unit} in stock.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ---------------- right: totals + payment ---------------- */}
      <form action={formAction} className="lg:col-span-2">
        <input type="hidden" name="cart" value={cartPayload} />

        <div className="space-y-4 lg:sticky lg:top-4">
          <div className="rounded-xl border border-line bg-surface-raised p-4">
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-content-muted">Subtotal</dt>
                <dd className="tabular text-content">{fmt(totals.subtotal)}</dd>
              </div>
              {totals.discount > 0 && (
                <div className="flex justify-between">
                  <dt className="text-content-muted">Discount</dt>
                  <dd className="tabular text-content">−{fmt(totals.discount)}</dd>
                </div>
              )}
              {/*
                One line per tax, named. A VAT invoice has to show each, and the
                customer at the counter is entitled to the same breakdown.
              */}
              {totals.taxLines.map(
                (line) =>
                  line.amount !== 0 && (
                    <div key={line.code} className="flex justify-between">
                      <dt className="text-content-muted">{line.name}</dt>
                      <dd className="tabular text-content">{fmt(line.amount)}</dd>
                    </div>
                  ),
              )}
              <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold">
                <dt className="text-content">Total</dt>
                <dd className="tabular text-content">
                  {currencyCode} {fmt(totals.total)}
                </dd>
              </div>
            </dl>

            {mayOverridePrice && (
              <div className="mt-3">
                <label htmlFor="invoice-discount" className="mb-1 block text-xs text-content-muted">
                  Discount on the whole sale
                </label>
                <AmountInput
                  id="invoice-discount"
                  value={invoiceDiscount}
                  onChange={(event) => setInvoiceDiscount(event.target.value)}
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-surface-raised p-4">
            <h2 className="mb-3 text-sm font-semibold text-content">Payment</h2>

            <div className="space-y-3">
              <div>
                <label htmlFor="tender-account" className="mb-1 block text-xs text-content-muted">
                  Method
                </label>
                <select
                  id="tender-account"
                  value={tenderAccountId}
                  onChange={(event) => setTenderAccountId(event.target.value)}
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
                <label htmlFor="tender-amount" className="mb-1 block text-xs text-content-muted">
                  Amount received
                </label>
                <div className="flex gap-2">
                  <AmountInput
                    id="tender-amount"
                    value={tenderAmount}
                    onChange={(event) => setTenderAmount(event.target.value)}
                    placeholder="0.00"
                    className="h-11 text-base"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setTenderAmount(fmt(totals.total))}
                    disabled={totals.total === 0}
                  >
                    Exact
                  </Button>
                </div>
              </div>

              {secondAccountId === '' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSecondAccountId(
                      String(accounts.find((a) => String(a.id) !== tenderAccountId)?.id ?? ''),
                    )
                  }
                  disabled={accounts.length < 2}
                >
                  + Split across a second method
                </Button>
              ) : (
                <div className="rounded-lg border border-line p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-content-muted">Second method</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSecondAccountId('');
                        setSecondAmount('');
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                  <select
                    value={secondAccountId}
                    onChange={(event) => setSecondAccountId(event.target.value)}
                    aria-label="Second payment method"
                    className="mb-2 h-10 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={String(account.id)}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                  <AmountInput
                    value={secondAmount}
                    onChange={(event) => setSecondAmount(event.target.value)}
                    placeholder="0.00"
                    aria-label="Second amount"
                    className="h-10"
                  />
                </div>
              )}

              <div>
                <label htmlFor="reference" className="mb-1 block text-xs text-content-muted">
                  Reference (optional)
                </label>
                <TextInput
                  id="reference"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="MoMo transaction id"
                  className="h-10"
                />
              </div>
            </div>

            <dl className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-content-muted">Received</dt>
                <dd className="tabular text-content">{fmt(totals.tendered)}</dd>
              </div>
              {totals.change > 0 && (
                <div className="flex justify-between text-base font-semibold">
                  <dt className="text-success">Change</dt>
                  <dd className="tabular text-success">{fmt(totals.change)}</dd>
                </div>
              )}
              {totals.outstanding > 0 && (
                <div className="flex justify-between text-base font-semibold">
                  <dt className="text-warning">Balance owing</dt>
                  <dd className="tabular text-warning">{fmt(totals.outstanding)}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="rounded-xl border border-line bg-surface-raised p-4">
            <label htmlFor="customer" className="mb-1 block text-xs text-content-muted">
              Customer {totals.outstanding > 0 && <span className="text-danger">(required)</span>}
            </label>
            <select
              id="customer"
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              <option value="">Walk-in customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={String(customer.id)}>
                  {customer.name}
                  {customer.balanceMinor > 0 ? ` — owes ${fmt(customer.balanceMinor)}` : ''}
                </option>
              ))}
            </select>

            <label htmlFor="note" className="mt-3 mb-1 block text-xs text-content-muted">
              Note (optional)
            </label>
            <TextInput
              id="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="h-10"
            />
          </div>

          {needsCustomer && (
            <Alert tone="warning">
              This sale is not fully paid. Choose a customer so the balance can be recorded against
              them.
            </Alert>
          )}

          {overselling.length > 0 && (
            <Alert tone="warning">
              Some items are more than you have in stock. The sale will be refused unless negative
              stock is switched on in Settings.
            </Alert>
          )}

          <Button type="submit" size="lg" fullWidth disabled={!canSubmit}>
            {pending
              ? 'Saving…'
              : totals.outstanding > 0
                ? `Save on credit — ${currencyCode} ${fmt(totals.total)}`
                : `Complete sale — ${currencyCode} ${fmt(totals.total)}`}
          </Button>
        </div>
      </form>
    </div>
  );
}
