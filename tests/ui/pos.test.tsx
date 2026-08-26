// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { SaleFormState } from '@/actions/sale.actions';

/**
 * The till, rendered.
 *
 * Every user-visible defect this application has had was found by looking at a
 * screen, never by a test: "1 entry **have** been posted", a warning class that
 * produced no colour, and "Only 0 pc still in date. The rest needs approval",
 * which is not English. Service tests cannot see any of that, because the
 * sentence is assembled in the component.
 *
 * These render the busiest and most dangerous screen in the app and assert what
 * a cashier would actually read. The rule they exist to protect is the one from
 * §4 of the expiry plan: expired stock is passed over IN SILENCE while good
 * stock covers the sale. A warning that fires when it need not is a warning
 * people learn to click past, and a till people route around is worse than no
 * till at all.
 */

/** The server action is a server module; the component only needs its shape. */
const action = vi.hoisted(() => ({
  current: async (_formData?: FormData): Promise<SaleFormState> => ({}),
}));
vi.mock('@/actions/sale.actions', () => ({
  createSaleAction: (_previous: SaleFormState, formData: FormData) => action.current(formData),
}));

const { Pos } = await import('@/app/(app)/sales/new/pos');

interface ProductOverrides {
  goodQtyMilli?: number;
  soonestExpiry?: string | null;
  warnDays?: number;
  qtyOnHandMilli?: number;
}

const product = (overrides: ProductOverrides = {}) => ({
  id: 1,
  name: 'Evaporated Milk',
  sku: 'MILK170',
  barcode: null,
  unit: 'tin',
  sellingPrice: 500,
  qtyOnHandMilli: overrides.qtyOnHandMilli ?? 50_000,
  trackInventory: true,
  goodQtyMilli: overrides.goodQtyMilli ?? 50_000,
  soonestExpiry: overrides.soonestExpiry ?? null,
  warnDays: overrides.warnDays ?? 30,
});

function renderTill(
  overrides: ProductOverrides = {},
  props: { maySellExpired?: boolean; expiryBlocksSales?: boolean } = {},
) {
  return render(
    <Pos
      products={[product(overrides)]}
      customers={[]}
      accounts={[{ id: 1, name: 'Cash', kind: 'CASH', isDefault: true }]}
      today="2026-08-26"
      currencyCode="GHS"
      taxComponents={[]}
      taxInclusive={false}
      mayOverridePrice={false}
      maySellExpired={props.maySellExpired ?? false}
      expiryBlocksSales={props.expiryBlocksSales ?? true}
      cartSeed="seed-abcdefgh"
    />,
  );
}

/** Put the product in the cart, the way a cashier does. */
function addToCart() {
  fireEvent.change(screen.getByLabelText(/find a product/i), { target: { value: 'Milk' } });
  fireEvent.click(screen.getByRole('button', { name: /Evaporated Milk/i }));
}

function setQuantity(value: string) {
  fireEvent.change(screen.getByLabelText(/qty/i), { target: { value } });
}

/**
 * The submit button, whichever it currently is.
 *
 * Its label changes with the cart: an unpaid basket reads "Save on credit",
 * a tendered one "Complete sale". Tests that only want to submit should not
 * care which.
 */
const submitButton = () => screen.getByRole('button', { name: /save on credit|complete sale/i });

/** Tender the exact amount, so the sale is a cash sale rather than an invoice. */
function payExact() {
  fireEvent.click(screen.getByRole('button', { name: /^exact$/i }));
}

afterEach(() => {
  cleanup();
  action.current = async () => ({});
});

describe('what the cashier is told about dates', () => {
  it('says NOTHING about expiry when there is no dated stock at all', () => {
    renderTill();
    addToCart();

    expect(screen.queryByText(/still in date/i)).toBeNull();
    expect(screen.queryByText(/expires/i)).toBeNull();
  });

  it('mentions the date quietly when stock is inside the warning window', () => {
    renderTill({ soonestExpiry: '2026-09-05', warnDays: 30 });
    addToCart();

    expect(screen.getByText(/expires/i)).toBeDefined();
    // Quiet, not a warning: nothing needs approving.
    expect(screen.queryByText(/still in date/i)).toBeNull();
  });

  it('stays silent when the date is beyond this product’s own window', () => {
    // Bread wants three days' notice; this is twenty days away.
    renderTill({ soonestExpiry: '2026-09-15', warnDays: 3 });
    addToCart();

    expect(screen.queryByText(/expires/i)).toBeNull();
  });

  it('says nothing while good stock covers the quantity, even with expired stock behind it', () => {
    // 50 on the shelf, 20 of them still in date. Selling 2 needs no approval,
    // and an old crate at the back is not the cashier's problem.
    renderTill({ qtyOnHandMilli: 50_000, goodQtyMilli: 20_000 });
    addToCart();
    setQuantity('2');

    expect(screen.queryByText(/still in date/i)).toBeNull();
    expect(screen.queryByText(/approval/i)).toBeNull();
  });
});

describe('when the quantity cannot be met from stock that is in date', () => {
  it('names how much IS in date, and who has to approve the rest', () => {
    renderTill({ qtyOnHandMilli: 50_000, goodQtyMilli: 2_000 }, { maySellExpired: false });
    addToCart();
    setQuantity('4');

    expect(screen.getByText(/Only 2 tin still in date/i)).toBeDefined();
    expect(screen.getByText(/The rest needs approval from someone senior/i)).toBeDefined();
  });

  it('tells somebody who CAN approve that they will be asked', () => {
    renderTill({ qtyOnHandMilli: 50_000, goodQtyMilli: 2_000 }, { maySellExpired: true });
    addToCart();
    setQuantity('4');

    expect(screen.getByText(/You will be asked to approve the rest/i)).toBeDefined();
  });

  it('does not say "Only 0 tin still in date", which is not English', () => {
    /**
     * A real defect, and one only a screen could show. When none of the stock
     * is in date, "Only 0 tin still in date. The rest needs approval" reads as
     * nonsense — and none of it being in date is the commonest case of all,
     * not an edge one.
     */
    renderTill({ qtyOnHandMilli: 50_000, goodQtyMilli: 0 }, { maySellExpired: false });
    addToCart();
    setQuantity('1');

    expect(screen.queryByText(/Only 0 tin/i)).toBeNull();
    expect(screen.getByText(/None of this is still in date/i)).toBeDefined();
    expect(screen.getByText(/Selling it needs approval from someone senior/i)).toBeDefined();
  });

  it('says nothing at all when the shop has turned the block off', () => {
    renderTill({ qtyOnHandMilli: 50_000, goodQtyMilli: 0 }, { expiryBlocksSales: false });
    addToCart();
    setQuantity('4');

    expect(screen.queryByText(/still in date/i)).toBeNull();
    expect(screen.queryByText(/approval/i)).toBeNull();
  });
});

describe('the block, and the one way past it', () => {
  const blocked: SaleFormState = {
    expired: {
      productName: 'Evaporated Milk',
      qtyExpired: '2',
      batchRefs: ['BAT-00002'],
      mayOverride: true,
    },
  };

  it('offers the approval to somebody who holds the right', async () => {
    action.current = async () => blocked;
    renderTill();
    addToCart();

    fireEvent.submit(submitButton().closest('form')!);
    expect(await screen.findByText(/has passed its date/i)).toBeDefined();

    expect(screen.getByText(/BAT-00002/)).toBeDefined();
    expect(screen.getByText(/Nothing has been saved/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /sell it anyway/i })).toBeDefined();
  });

  it('sends the approval with the BUTTON, so it cannot leak into an ordinary sale', async () => {
    /**
     * The mechanism that matters. A submit button's name and value reach the
     * server only when that button is the one pressed — so approving expired
     * stock is tied to pressing "Sell it anyway" and cannot survive in the
     * payload into a later ordinary press of "Complete sale", on a cart edited
     * in between.
     */
    action.current = async () => blocked;
    renderTill();
    addToCart();
    fireEvent.submit(submitButton().closest('form')!);

    const approve = await screen.findByRole('button', { name: /sell it anyway/i });
    expect(approve.getAttribute('name')).toBe('sellExpired');
    expect(approve.getAttribute('value')).toBe('yes');
    expect(approve.getAttribute('type')).toBe('submit');

    // And the ordinary button carries no such thing.
    expect(submitButton().getAttribute('name')).toBeNull();
  });

  it('offers no way past it to somebody who does not hold the right', async () => {
    action.current = async () => ({
      expired: { ...blocked.expired!, mayOverride: false },
    });
    renderTill();
    addToCart();
    fireEvent.submit(submitButton().closest('form')!);

    expect(await screen.findByText(/has passed its date/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: /sell it anyway/i })).toBeNull();
    expect(screen.getByText(/Someone who can approve it has to allow this sale/i)).toBeDefined();
  });
});

describe('the cart', () => {
  it('adds a product and totals it', () => {
    renderTill();
    addToCart();
    setQuantity('3');

    // 3 tins at 5.00. Unpaid, so it is an invoice rather than a cash sale.
    expect(screen.getByRole('button', { name: /save on credit/i }).textContent).toContain('15.00');

    // Tender it and the same button becomes a cash sale.
    payExact();
    expect(screen.getByRole('button', { name: /complete sale/i }).textContent).toContain('15.00');
  });

  it('will not let an empty cart be completed', () => {
    renderTill();
    expect(screen.getByRole('button', { name: /complete sale/i })).toHaveProperty('disabled', true);
  });

  it('warns when the quantity is more than the shelf holds', () => {
    renderTill({ qtyOnHandMilli: 2_000, goodQtyMilli: 2_000 });
    addToCart();
    setQuantity('5');

    expect(screen.getByText(/Only 2 tin in stock/i)).toBeDefined();
  });
});
