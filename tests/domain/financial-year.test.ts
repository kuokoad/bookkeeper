import { describe, expect, it } from 'vitest';

import {
  daysInMonth,
  financialYear,
  financialYearFor,
  financialYearsBetween,
  isWithin,
  previousFinancialYear,
} from '@/domain/financial-year';
import { ValidationError } from '@/domain/errors';

describe('a January financial year', () => {
  it('is the calendar year', () => {
    const year = financialYear(2025, 1);
    expect(year.start).toBe('2025-01-01');
    expect(year.end).toBe('2025-12-31');
    expect(year.label).toBe('2025');
  });
});

describe('a financial year that straddles two calendar years', () => {
  it('runs to the day before the anniversary', () => {
    const april = financialYear(2025, 4);
    expect(april.start).toBe('2025-04-01');
    expect(april.end).toBe('2026-03-31');
    expect(april.label).toBe('2025/26');
  });

  it('handles a start month whose previous month has 30 days', () => {
    // July start ends 30 June, not 31 June.
    expect(financialYear(2025, 7).end).toBe('2026-06-30');
  });

  it('handles a March start, where the year ends in February', () => {
    expect(financialYear(2025, 3).end).toBe('2026-02-28');
    // 2028 is a leap year, so the same shop's year ends a day later.
    expect(financialYear(2027, 3).end).toBe('2028-02-29');
  });

  it('labels the turn of a century readably', () => {
    expect(financialYear(2099, 4).label).toBe('2099/00');
  });
});

describe('February, which is where date arithmetic usually breaks', () => {
  it('knows the length of every February that matters', () => {
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    // Divisible by 100 but not 400 — not a leap year.
    expect(daysInMonth(1900, 2)).toBe(28);
    // Divisible by 400 — a leap year.
    expect(daysInMonth(2000, 2)).toBe(29);
  });
});

describe('finding the year a date belongs to', () => {
  it('places a date inside a January year', () => {
    expect(financialYearFor('2025-06-15', 1).label).toBe('2025');
    expect(financialYearFor('2025-01-01', 1).label).toBe('2025');
    expect(financialYearFor('2025-12-31', 1).label).toBe('2025');
  });

  it('places dates either side of an April start correctly', () => {
    // The day before the year opens still belongs to the previous year.
    expect(financialYearFor('2025-03-31', 4).label).toBe('2024/25');
    expect(financialYearFor('2025-04-01', 4).label).toBe('2025/26');
    // January falls in the year that began the previous April.
    expect(financialYearFor('2026-01-15', 4).label).toBe('2025/26');
  });

  it('never leaves a date homeless at a boundary', () => {
    // Every day of a year must fall inside exactly that year.
    const year = financialYear(2025, 4);
    for (const date of [year.start, '2025-12-31', '2026-01-01', year.end]) {
      expect(financialYearFor(date, 4).label, date).toBe(year.label);
      expect(isWithin(date, year), date).toBe(true);
    }
    // And the days just outside must not.
    expect(isWithin('2025-03-31', year)).toBe(false);
    expect(isWithin('2026-04-01', year)).toBe(false);
  });
});

describe('the comparative year', () => {
  it('is the one immediately before, ending the day this one starts', () => {
    const year = financialYear(2025, 4);
    const previous = previousFinancialYear(year, 4);

    expect(previous.label).toBe('2024/25');
    expect(previous.end).toBe('2025-03-31');
    // No gap and no overlap between the two periods.
    expect(financialYearFor(previous.end, 4).label).toBe(previous.label);
    expect(previous.end < year.start).toBe(true);
  });
});

describe('listing the years a shop has traded', () => {
  it('returns newest first, covering both ends', () => {
    const years = financialYearsBetween('2023-05-02', '2025-11-30', 1).map((y) => y.label);
    expect(years).toEqual(['2025', '2024', '2023']);
  });

  it('returns a single year when all the trading is in one', () => {
    expect(financialYearsBetween('2025-02-01', '2025-11-30', 1).map((y) => y.label)).toEqual([
      '2025',
    ]);
  });

  it('respects a non-January start when deciding how many years there are', () => {
    // Both dates sit inside one April-to-March year, despite spanning
    // two calendar years.
    expect(financialYearsBetween('2025-04-01', '2026-03-31', 4).map((y) => y.label)).toEqual([
      '2025/26',
    ]);
  });
});

describe('refusing nonsense', () => {
  it('rejects a month outside 1-12', () => {
    for (const month of [0, 13, -1, 1.5]) {
      expect(() => financialYear(2025, month), String(month)).toThrow(ValidationError);
    }
  });

  it('rejects a date that is not a business date', () => {
    expect(() => financialYearFor('15/06/2025', 1)).toThrow(ValidationError);
    expect(() => financialYearFor('', 1)).toThrow(ValidationError);
  });
});
