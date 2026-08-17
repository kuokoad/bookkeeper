import { describe, expect, it } from 'vitest';

import { formatBasisPoints, parsePercentToBasisPoints } from '@/domain/rate';
import { ValidationError } from '@/domain/errors';

describe('reading a percentage', () => {
  it('converts what a person types into basis points', () => {
    expect(parsePercentToBasisPoints('12.5')).toBe(1250);
    expect(parsePercentToBasisPoints('12')).toBe(1200);
    expect(parsePercentToBasisPoints('0')).toBe(0);
    expect(parsePercentToBasisPoints('100')).toBe(10_000);
  });

  it('keeps rates that a float would get wrong', () => {
    // 7.3% is 0.073 in floating point, which is not exact. As basis points it
    // is simply 730, and stays that way however many sales it is applied to.
    expect(parsePercentToBasisPoints('7.3')).toBe(730);
    expect(parsePercentToBasisPoints('0.01')).toBe(1);
    expect(parsePercentToBasisPoints('0.75')).toBe(75);
  });

  it('ignores surrounding space', () => {
    expect(parsePercentToBasisPoints('  15  ')).toBe(1500);
  });

  it('refuses anything that is not a plain percentage', () => {
    for (const input of ['', '  ', 'abc', '12%', '1.234', '-5', '+5', '1e2', '1,5']) {
      expect(() => parsePercentToBasisPoints(input), input).toThrow(ValidationError);
    }
  });

  it('refuses a rate above 100%', () => {
    expect(() => parsePercentToBasisPoints('100.01')).toThrow(/above 100/i);
    expect(() => parsePercentToBasisPoints('150')).toThrow(/above 100/i);
  });

  it('refuses a negative rate outright rather than storing one', () => {
    // A negative tax rate would post a debit where a credit belongs.
    expect(() => parsePercentToBasisPoints('-12.5')).toThrow(ValidationError);
  });
});

describe('showing a percentage', () => {
  it('reads back the way it was entered', () => {
    expect(formatBasisPoints(1250)).toBe('12.5');
    expect(formatBasisPoints(1200)).toBe('12');
    expect(formatBasisPoints(0)).toBe('0');
    expect(formatBasisPoints(75)).toBe('0.75');
    expect(formatBasisPoints(1)).toBe('0.01');
    expect(formatBasisPoints(10_000)).toBe('100');
  });

  it('refuses a fractional basis point, which cannot be stored', () => {
    expect(() => formatBasisPoints(12.5)).toThrow(ValidationError);
  });
});

describe('the round trip', () => {
  it('returns exactly what went in, for every rate a shop could set', () => {
    // The property that matters: what is shown in the form must parse back to
    // the same stored value, or a save that changed nothing would change the
    // tax rate.
    for (let bp = 0; bp <= 10_000; bp += 1) {
      expect(parsePercentToBasisPoints(formatBasisPoints(bp))).toBe(bp);
    }
  });
});
