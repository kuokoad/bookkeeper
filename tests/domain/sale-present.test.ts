import { describe, expect, it } from 'vitest';

import { calculateSale } from '@/domain/sales/calculate';
import { saleDocumentTotals } from '@/domain/sales/present';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

/**
 * What the customer reads has to agree with itself.
 *
 * The ledger stores every sale net of tax so one arithmetic rule covers both
 * pricing styles. A receipt printed straight from those columns would, under
 * inclusive pricing, show a subtotal lower than the lines printed above it —
 * and a customer holding that paper would be right to query it.
 */

/** Round-trip: price a sale, store it the way the service does, print it. */
function priceAndPrint(input: Parameters<typeof calculateSale>[0], taxInclusive: boolean) {
  const totals = calculateSale(input);
  const stored = {
    subtotalMinor: totals.subtotalExTax,
    discountMinor: totals.invoiceDiscountExTax,
    taxMinor: totals.tax,
    totalMinor: totals.total,
    taxInclusive,
  };
  return {
    totals,
    stored,
    printed: saleDocumentTotals(
      stored,
      totals.lines.map((line) => line.lineTotal),
    ),
  };
}

describe('printing a tax-inclusive sale', () => {
  it('shows a subtotal that matches the printed lines', () => {
    const { printed } = priceAndPrint(
      {
        lines: [{ productId: 1, qty: u(2), unitPrice: m(11_250) }],
        taxRateBp: 1_250,
        taxInclusive: true,
      },
      true,
    );

    // Two lines at GHS 112.50 as printed = GHS 225.00.
    expect(printed.subtotal).toBe(22_500);
    expect(printed.total).toBe(22_500);
    expect(printed.tax).toBe(2_500);
    expect(printed.taxWithinTotal).toBe(true);
  });

  it('shows the discount the customer was actually given', () => {
    const { printed } = priceAndPrint(
      {
        lines: [{ productId: 1, qty: u(2), unitPrice: m(11_250) }],
        invoiceDiscount: m(2_250),
        taxRateBp: 1_250,
        taxInclusive: true,
      },
      true,
    );

    // GHS 22.50 was taken off at the counter, so GHS 22.50 is what it says —
    // not the GHS 20.00 that reaches the revenue account.
    expect(printed.discount).toBe(2_250);
    expect(printed.subtotal).toBe(22_500);
    expect(printed.total).toBe(20_250);
  });

  it('adds up on the page: subtotal − discount = total', () => {
    const { printed } = priceAndPrint(
      {
        lines: [{ productId: 1, qty: u(3), unitPrice: m(11_250), discount: m(1_000) }],
        invoiceDiscount: m(1_337),
        taxRateBp: 1_250,
        taxInclusive: true,
      },
      true,
    );

    expect(printed.subtotal - printed.discount).toBe(printed.total);
  });
});

describe('printing a tax-exclusive sale', () => {
  it('shows tax as a line to be added, exactly as before', () => {
    const { printed, stored } = priceAndPrint(
      {
        lines: [{ productId: 1, qty: u(1), unitPrice: m(10_000) }],
        taxRateBp: 1_250,
      },
      false,
    );

    expect(printed.taxWithinTotal).toBe(false);
    expect(printed.subtotal).toBe(10_000);
    expect(printed.tax).toBe(1_250);
    expect(printed.total).toBe(11_250);
    // Nothing derived: these are the stored columns, untouched.
    expect(printed.subtotal).toBe(stored.subtotalMinor);
    expect(printed.discount).toBe(stored.discountMinor);
  });
});

describe('the stored identity holds either way', () => {
  const cases = [
    { label: 'no tax', taxRateBp: 0, taxInclusive: false },
    { label: 'tax added on', taxRateBp: 1_250, taxInclusive: false },
    { label: 'tax within the price', taxRateBp: 1_250, taxInclusive: true },
    { label: 'an awkward rate, within the price', taxRateBp: 733, taxInclusive: true },
  ];

  for (const { label, taxRateBp, taxInclusive } of cases) {
    it(`${label}: subtotal − discount + tax = total, to the pesewa`, () => {
      const { stored } = priceAndPrint(
        {
          lines: [
            { productId: 1, qty: u(3), unitPrice: m(3_333), discount: m(777) },
            { productId: 2, qty: u(7), unitPrice: m(1_111) },
          ],
          invoiceDiscount: m(1_234),
          taxRateBp,
          taxInclusive,
        },
        taxInclusive,
      );

      expect(stored.subtotalMinor - stored.discountMinor + stored.taxMinor).toBe(
        stored.totalMinor,
      );
    });
  }
});
