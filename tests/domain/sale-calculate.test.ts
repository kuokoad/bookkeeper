import { describe, expect, it } from 'vitest';

import {
  calculateSale,
  calculateTender,
  creditHeadroom,
  exceedsCreditLimit,
  grossProfit,
  marginBp,
} from '@/domain/sales/calculate';
import { minor, sum, type Minor } from '@/domain/money';
import { fromUnits, parseQty, type Qty } from '@/domain/quantity';
import { ValidationError } from '@/domain/errors';
import type { TaxComponent } from '@/domain/tax/components';

/** A single 12.5% tax, the shape the sale arithmetic now takes. */
const ONE_TAX: TaxComponent[] = [
  { code: 'VAT', name: 'VAT', rateBp: 1_250, basis: 'NET', isRecoverable: true },
];

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

describe('line totals', () => {
  it('multiplies quantity by price', () => {
    const result = calculateSale({
      lines: [
        { productId: 1, qty: u(3), unitPrice: m(600) }, // 3 x 6.00 = 18.00
        { productId: 2, qty: u(2), unitPrice: m(300) }, // 2 x 3.00 = 6.00
      ],
    });

    expect(result.lines[0]?.gross).toBe(1_800);
    expect(result.lines[1]?.gross).toBe(600);
    expect(result.subtotal).toBe(2_400);
    expect(result.total).toBe(2_400);
  });

  it('handles fractional quantities', () => {
    // 2.5 kg of rice at GHS 19.00/kg = GHS 47.50
    const result = calculateSale({
      lines: [{ productId: 1, qty: parseQty('2.5'), unitPrice: m(1_900) }],
    });
    expect(result.total).toBe(4_750);
  });

  it('applies a line discount', () => {
    const result = calculateSale({
      lines: [{ productId: 1, qty: u(10), unitPrice: m(600), discount: m(500) }],
    });
    expect(result.lines[0]?.gross).toBe(6_000);
    expect(result.lines[0]?.lineTotal).toBe(5_500);
    expect(result.subtotal).toBe(5_500);
    expect(result.totalDiscount).toBe(500);
  });

  it('rejects a line discount larger than the line', () => {
    expect(() =>
      calculateSale({ lines: [{ productId: 1, qty: u(1), unitPrice: m(100), discount: m(200) }] }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty sale, zero quantity and negative price', () => {
    expect(() => calculateSale({ lines: [] })).toThrow(ValidationError);
    expect(() => calculateSale({ lines: [{ productId: 1, qty: u(0), unitPrice: m(100) }] })).toThrow(
      ValidationError,
    );
    expect(() =>
      calculateSale({ lines: [{ productId: 1, qty: u(1), unitPrice: m(-1) }] }),
    ).toThrow(ValidationError);
  });
});

describe('invoice-level discount', () => {
  it('spreads across lines without losing a pesewa', () => {
    // GHS 1.00 discount across three equal lines cannot divide evenly.
    const result = calculateSale({
      lines: [
        { productId: 1, qty: u(1), unitPrice: m(1_000) },
        { productId: 2, qty: u(1), unitPrice: m(1_000) },
        { productId: 3, qty: u(1), unitPrice: m(1_000) },
      ],
      invoiceDiscount: m(100),
    });

    const allocatedTotal = sum(result.lines.map((line) => line.allocatedInvoiceDiscount));
    expect(allocatedTotal).toBe(100);
    expect(sum(result.lines.map((line) => line.netTotal))).toBe(result.netBeforeTax);
    expect(result.total).toBe(2_900);
  });

  it('spreads in proportion to line value', () => {
    const result = calculateSale({
      lines: [
        { productId: 1, qty: u(1), unitPrice: m(7_500) },
        { productId: 2, qty: u(1), unitPrice: m(2_500) },
      ],
      invoiceDiscount: m(1_000),
    });

    expect(result.lines[0]?.allocatedInvoiceDiscount).toBe(750);
    expect(result.lines[1]?.allocatedInvoiceDiscount).toBe(250);
  });

  it('conserves the discount across many awkward splits', () => {
    for (const discount of [1, 7, 33, 99, 101, 1_234]) {
      const result = calculateSale({
        lines: [
          { productId: 1, qty: u(1), unitPrice: m(1_111) },
          { productId: 2, qty: u(1), unitPrice: m(2_222) },
          { productId: 3, qty: u(1), unitPrice: m(3_333) },
        ],
        invoiceDiscount: m(discount),
      });
      expect(sum(result.lines.map((l) => l.allocatedInvoiceDiscount)), `discount ${discount}`).toBe(
        discount,
      );
      expect(sum(result.lines.map((l) => l.netTotal))).toBe(result.netBeforeTax);
    }
  });

  it('rejects a discount larger than the sale', () => {
    expect(() =>
      calculateSale({
        lines: [{ productId: 1, qty: u(1), unitPrice: m(500) }],
        invoiceDiscount: m(600),
      }),
    ).toThrow(ValidationError);
  });

  it('combines line and invoice discounts', () => {
    const result = calculateSale({
      lines: [{ productId: 1, qty: u(1), unitPrice: m(1_000), discount: m(100) }],
      invoiceDiscount: m(50),
    });
    expect(result.subtotal).toBe(900);
    expect(result.totalDiscount).toBe(150);
    expect(result.total).toBe(850);
  });
});

describe('tax', () => {
  it('adds tax on top when prices exclude it', () => {
    // GHS 100.00 at 12.5% = GHS 12.50 tax
    const result = calculateSale({
      lines: [{ productId: 1, qty: u(1), unitPrice: m(10_000) }],
      taxComponents: ONE_TAX,
    });
    expect(result.netBeforeTax).toBe(10_000);
    expect(result.tax).toBe(1_250);
    expect(result.total).toBe(11_250);
  });

  it('extracts tax from within when prices include it', () => {
    // GHS 112.50 inclusive of 12.5% contains GHS 12.50 tax.
    const result = calculateSale({
      lines: [{ productId: 1, qty: u(1), unitPrice: m(11_250) }],
      taxComponents: ONE_TAX,
      taxInclusive: true,
    });
    expect(result.total).toBe(11_250);
    expect(result.tax).toBe(1_250);
  });

  it('is zero when tax is switched off', () => {
    const result = calculateSale({
      lines: [{ productId: 1, qty: u(1), unitPrice: m(10_000) }],
    });
    expect(result.tax).toBe(0);
    expect(result.total).toBe(10_000);
  });

  it('taxes the discounted amount, not the gross', () => {
    const result = calculateSale({
      lines: [{ productId: 1, qty: u(1), unitPrice: m(10_000) }],
      invoiceDiscount: m(2_000),
      taxComponents: ONE_TAX,
    });
    expect(result.netBeforeTax).toBe(8_000);
    expect(result.tax).toBe(1_000);
    expect(result.total).toBe(9_000);
  });
});

describe('tender, change and outstanding', () => {
  const TOTAL = m(4_700); // GHS 47.00

  it('exact payment leaves nothing owing and no change', () => {
    const result = calculateTender(TOTAL, [{ paymentAccountId: 1, amount: m(4_700) }]);
    expect(result.change).toBe(0);
    expect(result.outstanding).toBe(0);
    expect(result.applied).toBe(4_700);
  });

  it('over-tendering gives change, never extra revenue', () => {
    const result = calculateTender(TOTAL, [{ paymentAccountId: 1, amount: m(5_000) }]);
    expect(result.change).toBe(300);
    expect(result.outstanding).toBe(0);
    // Only the sale total is applied — the excess is handed back.
    expect(result.applied).toBe(4_700);
  });

  it('under-tendering leaves an outstanding balance', () => {
    const result = calculateTender(TOTAL, [{ paymentAccountId: 1, amount: m(2_000) }]);
    expect(result.outstanding).toBe(2_700);
    expect(result.change).toBe(0);
    expect(result.applied).toBe(2_000);
  });

  it('paying nothing makes the whole sale a receivable', () => {
    const result = calculateTender(TOTAL, []);
    expect(result.outstanding).toBe(4_700);
    expect(result.tendered).toBe(0);
  });

  it('handles a split payment across methods', () => {
    const result = calculateTender(TOTAL, [
      { paymentAccountId: 1, amount: m(2_000) }, // cash
      { paymentAccountId: 2, amount: m(2_700) }, // MoMo
    ]);
    expect(result.tendered).toBe(4_700);
    expect(result.outstanding).toBe(0);
    expect(result.change).toBe(0);
  });

  it('splits that overshoot still only apply the total', () => {
    const result = calculateTender(TOTAL, [
      { paymentAccountId: 1, amount: m(2_000) },
      { paymentAccountId: 2, amount: m(4_000) },
    ]);
    expect(result.applied).toBe(4_700);
    expect(result.change).toBe(1_300);
  });

  it('can refuse over-tendering where change is not possible', () => {
    expect(() =>
      calculateTender(TOTAL, [{ paymentAccountId: 1, amount: m(5_000) }], { allowChange: false }),
    ).toThrow(ValidationError);
  });

  it('rejects a negative payment', () => {
    expect(() => calculateTender(TOTAL, [{ paymentAccountId: 1, amount: m(-1) }])).toThrow(
      ValidationError,
    );
  });
});

describe('profit', () => {
  it('is revenue less the cost of the goods', () => {
    expect(grossProfit(m(50_000), m(32_000))).toBe(18_000);
  });

  it('can be negative when goods are sold below cost', () => {
    expect(grossProfit(m(1_000), m(1_500))).toBe(-500);
  });

  it('reports margin in basis points', () => {
    expect(marginBp(m(50_000), m(32_000))).toBe(3_600); // 36%
    expect(marginBp(m(1_000), m(1_000))).toBe(0);
  });

  it('returns null rather than a misleading zero when there is no revenue', () => {
    expect(marginBp(m(0), m(0))).toBeNull();
  });
});

describe('credit limits', () => {
  it('reports headroom against the limit', () => {
    expect(creditHeadroom(m(50_000), m(20_000))).toBe(30_000);
    expect(creditHeadroom(m(50_000), m(60_000))).toBe(0);
  });

  it('treats no limit as unlimited, distinct from a zero limit', () => {
    expect(creditHeadroom(null, m(99_999))).toBeNull();
    expect(exceedsCreditLimit(null, m(99_999), m(50_000))).toBe(false);
    // A zero limit means no credit at all.
    expect(exceedsCreditLimit(m(0), m(0), m(1))).toBe(true);
  });

  it('detects when a new credit sale would breach the limit', () => {
    expect(exceedsCreditLimit(m(50_000), m(30_000), m(10_000))).toBe(false);
    expect(exceedsCreditLimit(m(50_000), m(30_000), m(25_000))).toBe(true);
    // Exactly at the limit is allowed.
    expect(exceedsCreditLimit(m(50_000), m(30_000), m(20_000))).toBe(false);
  });
});
