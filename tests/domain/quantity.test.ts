import { describe, expect, it } from 'vitest';
import {
  addQty,
  derivedUnitPrice,
  extendPrice,
  formatQty,
  formatQtyWithUnit,
  fromUnits,
  parsePositiveQty,
  parseQty,
  qty,
  QTY_ONE,
  scaleQty,
  subtractQty,
  sumQty,
  toQtyInputString,
  type Qty,
} from '@/domain/quantity';
import { minor, type Minor } from '@/domain/money';
import { MoneyOverflowError, ValidationError } from '@/domain/errors';

const q = (n: number): Qty => qty(n);
const m = (n: number): Minor => minor(n);

describe('parseQty', () => {
  it('parses whole and fractional quantities', () => {
    expect(parseQty('3')).toBe(3000);
    expect(parseQty('1.5')).toBe(1500);
    expect(parseQty('0.750')).toBe(750);
    expect(parseQty('1,200')).toBe(1_200_000);
  });

  it('pads decimals to milli-units correctly', () => {
    expect(parseQty('1.5')).toBe(1500);
    expect(parseQty('1.05')).toBe(1050);
    expect(parseQty('1.005')).toBe(1005);
  });

  it('rejects more than three decimal places', () => {
    expect(() => parseQty('1.0005')).toThrow(ValidationError);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'abc', '1.2.3', '--1']) {
      expect(() => parseQty(bad), `expected "${bad}" to be rejected`).toThrow(ValidationError);
    }
  });

  it('parsePositiveQty rejects zero and negatives', () => {
    expect(() => parsePositiveQty('0')).toThrow(ValidationError);
    expect(() => parsePositiveQty('-1')).toThrow(ValidationError);
    expect(parsePositiveQty('2')).toBe(2000);
  });
});

describe('fromUnits', () => {
  it('avoids float error', () => {
    expect(fromUnits(0.1 + 0.2)).toBe(300);
    expect(fromUnits(3)).toBe(3000);
  });
});

describe('qty()', () => {
  it('rejects fractional milli-units and unsafe values', () => {
    expect(() => qty(1.5)).toThrow(ValidationError);
    expect(() => qty(Number.NaN)).toThrow(ValidationError);
    expect(() => qty(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyOverflowError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addQty(q(1500), q(1500))).toBe(3000);
    expect(subtractQty(q(3000), q(1500))).toBe(1500);
    expect(sumQty([q(1000), q(500), q(250)])).toBe(1750);
    expect(sumQty([])).toBe(0);
  });

  it('scales proportionally with half-away-from-zero rounding', () => {
    expect(scaleQty(q(1000), 1, 3)).toBe(333);
    expect(scaleQty(q(1000), 1, 2)).toBe(500);
    expect(scaleQty(q(5), 1, 2)).toBe(3);
  });
});

describe('extendPrice — the money/quantity bridge', () => {
  it('computes whole-unit line totals', () => {
    // 3 x GHS 8.70 = GHS 26.10
    expect(extendPrice(m(870), q(3000))).toBe(2610);
  });

  it('computes fractional line totals', () => {
    // 1.5 kg x GHS 12.00 = GHS 18.00
    expect(extendPrice(m(1200), q(1500))).toBe(1800);
    // 0.75 L x GHS 10.00 = GHS 7.50
    expect(extendPrice(m(1000), q(750))).toBe(750);
  });

  it('rounds to the nearest pesewa', () => {
    // 0.333 x GHS 1.00 = GHS 0.333 -> 0.33
    expect(extendPrice(m(100), q(333))).toBe(33);
    // 0.335 x GHS 1.00 = GHS 0.335 -> 0.34 (half away from zero)
    expect(extendPrice(m(100), q(335))).toBe(34);
  });

  it('is exact for a unit quantity', () => {
    expect(extendPrice(m(12_345), QTY_ONE)).toBe(12_345);
  });

  it('handles zero', () => {
    expect(extendPrice(m(1000), q(0))).toBe(0);
    expect(extendPrice(m(0), q(5000))).toBe(0);
  });

  it('does not overflow on large but realistic line totals', () => {
    // 10,000 units at GHS 50,000.00 each
    expect(extendPrice(m(5_000_000), q(10_000_000))).toBe(50_000_000_000);
  });
});

describe('derivedUnitPrice', () => {
  it('inverts extendPrice for exact cases', () => {
    expect(derivedUnitPrice(m(2610), q(3000))).toBe(870);
  });

  it('rejects zero quantity', () => {
    expect(() => derivedUnitPrice(m(100), q(0))).toThrow(ValidationError);
  });
});

describe('formatting', () => {
  it('trims trailing zeros', () => {
    expect(formatQty(q(3000))).toBe('3');
    expect(formatQty(q(1500))).toBe('1.5');
    expect(formatQty(q(750))).toBe('0.75');
    expect(formatQty(q(1005))).toBe('1.005');
    expect(formatQty(q(0))).toBe('0');
    expect(formatQty(q(-1500))).toBe('-1.5');
    expect(formatQty(q(1_200_000))).toBe('1,200');
  });

  it('appends a unit', () => {
    expect(formatQtyWithUnit(q(1500), 'kg')).toBe('1.5 kg');
    expect(formatQtyWithUnit(q(3000), '')).toBe('3');
  });

  it('round-trips through the input representation', () => {
    for (const value of [0, 750, 1500, 3000, 1_200_000]) {
      expect(parseQty(toQtyInputString(q(value)))).toBe(value);
    }
  });
});
