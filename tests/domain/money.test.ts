import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  atLeastZero,
  BASIS_POINTS,
  formatMoney,
  fromMajor,
  minor,
  mulDiv,
  multiply,
  negate,
  parseMoney,
  percentOf,
  subtract,
  sum,
  toDecimalString,
  toInputString,
  ZERO,
  type Minor,
} from '@/domain/money';
import { MoneyOverflowError, ValidationError } from '@/domain/errors';

const m = (n: number): Minor => minor(n);

describe('parseMoney', () => {
  it('parses plain and grouped amounts', () => {
    expect(parseMoney('1250')).toBe(125_000);
    expect(parseMoney('1250.50')).toBe(125_050);
    expect(parseMoney('1,250.50')).toBe(125_050);
    expect(parseMoney('0.05')).toBe(5);
    expect(parseMoney('0')).toBe(0);
  });

  it('pads a single decimal place correctly', () => {
    // The classic bug: "1250.5" must be 1250.50, not 1250.05.
    expect(parseMoney('1250.5')).toBe(125_050);
  });

  it('strips currency codes and symbols', () => {
    expect(parseMoney('GHS 1,250.50')).toBe(125_050);
    expect(parseMoney(' ₵80.00 ')).toBe(8_000);
  });

  it('handles negatives in both notations', () => {
    expect(parseMoney('-50.00')).toBe(-5_000);
    expect(parseMoney('(50.00)')).toBe(-5_000);
  });

  it('rejects more than two decimal places instead of truncating', () => {
    expect(() => parseMoney('10.005')).toThrow(ValidationError);
  });

  it('rejects junk input', () => {
    // "--1" is the important one: a double negative must never become positive.
    for (const bad of ['', '   ', 'abc', '1.2.3', '10-', '1,25,0.00', '--1', '(-1)', '-']) {
      expect(() => parseMoney(bad), `expected "${bad}" to be rejected`).toThrow(ValidationError);
    }
  });
});

describe('fromMajor', () => {
  it('does not inherit binary floating point error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754.
    expect(fromMajor(0.1 + 0.2)).toBe(30);
    expect(fromMajor(8.7)).toBe(870);
    expect(fromMajor(-12.34)).toBe(-1234);
  });

  it('cannot recover precision the caller already lost', () => {
    // Documents a real limitation rather than pretending it away: the literal
    // 1.005 is 1.00499999999999989 as a double, so 1.00 is the honest result.
    // This is exactly why user input goes through parseMoney(string) instead.
    expect(fromMajor(1.005)).toBe(100);
    // The string path refuses the ambiguity outright instead of guessing.
    expect(() => parseMoney('1.005')).toThrow(ValidationError);
  });
});

describe('minor()', () => {
  it('rejects fractional and unsafe values', () => {
    expect(() => minor(12.5)).toThrow(ValidationError);
    expect(() => minor(Number.NaN)).toThrow(ValidationError);
    expect(() => minor(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
    expect(() => minor(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyOverflowError);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates and sums exactly', () => {
    expect(add(m(125_000), m(5_050))).toBe(130_050);
    expect(subtract(m(125_000), m(5_050))).toBe(119_950);
    expect(negate(m(125_000))).toBe(-125_000);
    expect(sum([m(10), m(20), m(30)])).toBe(60);
    expect(sum([])).toBe(0);
  });

  it('accumulates a thousand additions of 0.01 without drift', () => {
    let total = ZERO;
    for (let i = 0; i < 1000; i++) total = add(total, m(1));
    expect(total).toBe(1000); // exactly GHS 10.00
  });

  it('throws rather than overflowing', () => {
    expect(() => multiply(m(Number.MAX_SAFE_INTEGER - 1), 1000)).toThrow(MoneyOverflowError);
  });

  it('clamps to zero', () => {
    expect(atLeastZero(m(-500))).toBe(0);
    expect(atLeastZero(m(500))).toBe(500);
  });
});

describe('mulDiv rounding', () => {
  it('rounds half away from zero', () => {
    expect(mulDiv(m(5), 1, 2)).toBe(3); // 2.5 -> 3
    expect(mulDiv(m(-5), 1, 2)).toBe(-3); // -2.5 -> -3
    expect(mulDiv(m(7), 1, 2)).toBe(4); // 3.5 -> 4
    expect(mulDiv(m(4), 1, 2)).toBe(2); // exact
  });

  it('survives products larger than MAX_SAFE_INTEGER', () => {
    // 10 billion pesewas x 1e6 / 1e6 would overflow a plain number product.
    const big = m(10_000_000_000);
    expect(mulDiv(big, 1_000_000, 1_000_000)).toBe(10_000_000_000);
  });

  it('rejects division by zero', () => {
    expect(() => mulDiv(m(100), 1, 0)).toThrow(ValidationError);
  });
});

describe('percentOf', () => {
  it('computes basis-point rates', () => {
    expect(percentOf(m(125_000), 1250)).toBe(15_625); // 12.5% of 1250.00 = 156.25
    expect(percentOf(m(10_000), BASIS_POINTS)).toBe(10_000); // 100%
    expect(percentOf(m(10_000), 0)).toBe(0);
  });

  it('requires whole basis points', () => {
    expect(() => percentOf(m(100), 12.5)).toThrow(ValidationError);
  });
});

describe('allocate', () => {
  it('never loses or invents a pesewa', () => {
    // GHS 1.00 across three lines cannot divide evenly.
    const parts = allocate(m(100), [1, 1, 1]);
    expect(sum(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('weights proportionally', () => {
    const parts = allocate(m(1000), [50, 30, 20]);
    expect(sum(parts)).toBe(1000);
    expect(parts).toEqual([500, 300, 200]);
  });

  it('conserves the total across many awkward splits', () => {
    for (let total = 1; total <= 200; total++) {
      for (const weights of [[1, 1, 1], [7, 11, 13], [1, 0, 5], [3]]) {
        const parts = allocate(m(total), weights);
        expect(sum(parts), `total=${total} weights=${weights}`).toBe(total);
      }
    }
  });

  it('conserves negative totals too (used when reversing a transaction)', () => {
    const parts = allocate(m(-100), [1, 1, 1]);
    expect(sum(parts)).toBe(-100);
  });

  it('splits evenly when all weights are zero', () => {
    const parts = allocate(m(10), [0, 0, 0, 0]);
    expect(sum(parts)).toBe(10);
  });

  it('rejects empty or negative weights', () => {
    expect(() => allocate(m(100), [])).toThrow(ValidationError);
    expect(() => allocate(m(100), [1, -1])).toThrow(ValidationError);
  });
});

describe('formatting', () => {
  it('formats with grouping and two decimals', () => {
    expect(formatMoney(m(125_000))).toBe('GHS 1,250.00');
    expect(formatMoney(m(5))).toBe('GHS 0.05');
    expect(formatMoney(m(0))).toBe('GHS 0.00');
    expect(formatMoney(m(-125_000))).toBe('GHS -1,250.00');
    expect(formatMoney(m(123_456_789))).toBe('GHS 1,234,567.89');
  });

  it('supports a different currency without code changes', () => {
    expect(formatMoney(m(125_000), 'NGN')).toBe('NGN 1,250.00');
  });

  it('round-trips through the input representation', () => {
    for (const value of [0, 5, 100, 125_050, -9_999_99]) {
      expect(parseMoney(toInputString(m(value)))).toBe(value);
    }
  });

  it('omits grouping when asked', () => {
    expect(toDecimalString(m(125_000), false)).toBe('1250.00');
  });
});
