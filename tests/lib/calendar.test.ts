import { describe, expect, it } from 'vitest';

import {
  MONTH_NAMES,
  WEEKDAY_LABELS,
  clampToBounds,
  daysInMonth,
  isSelectable,
  longDate,
  monthGrid,
  parseParts,
  shiftDate,
  shiftMonth,
  toDateString,
  weekdayIndex,
} from '@/lib/calendar';

/**
 * The arithmetic behind the date picker.
 *
 * Tested here rather than through the component, because the cases that break a
 * calendar are all arithmetic: a month starting on a Sunday, February in a leap
 * year, the week straddling a year end. None of them need a browser.
 */

describe('the week', () => {
  it('starts on Monday, as the shop does', () => {
    expect(WEEKDAY_LABELS[0]).toBe('Mon');
    expect(WEEKDAY_LABELS[6]).toBe('Sun');
  });

  it('puts each day in the right column', () => {
    // 2026-08-31 is a Monday.
    expect(weekdayIndex('2026-08-31')).toBe(0);
    expect(weekdayIndex('2026-09-06')).toBe(6); // the Sunday after
    expect(weekdayIndex('2026-01-01')).toBe(3); // a Thursday
  });

  it('does not throw on junk, it answers Monday', () => {
    expect(weekdayIndex('not-a-date')).toBe(0);
  });
});

describe('how long a month is', () => {
  it('knows the short ones', () => {
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('knows February in an ordinary year and a leap year', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    // The rule people forget: 1900 was not a leap year, 2000 was.
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
});

describe('the month grid', () => {
  /**
   * Six rows always. A grid that changed height as you paged through the year
   * would move the buttons under the pointer, and the row you were about to
   * click would not be where you left it.
   */
  it('is always six rows of seven', () => {
    for (const [year, month] of [
      [2026, 2],
      [2026, 8],
      [2028, 2],
      [2026, 11],
    ] as const) {
      const weeks = monthGrid(year, month);
      expect(weeks).toHaveLength(6);
      for (const week of weeks) expect(week).toHaveLength(7);
    }
  });

  it('opens on the right weekday', () => {
    // 1 August 2026 is a Saturday: five padding days before it.
    const first = monthGrid(2026, 8)[0]!;
    expect(first.filter((cell) => !cell.inMonth)).toHaveLength(5);
    expect(first[5]).toMatchObject({ date: '2026-08-01', day: 1, inMonth: true });
  });

  it('pads from the months either side, marked as outside', () => {
    const weeks = monthGrid(2026, 8);
    const lead = weeks[0]!.filter((cell) => !cell.inMonth);
    expect(lead.map((cell) => cell.date)).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
  });

  it('carries the year across January and December', () => {
    expect(monthGrid(2026, 1)[0]!.some((cell) => cell.date.startsWith('2025-12'))).toBe(true);
    expect(monthGrid(2026, 12)[5]!.some((cell) => cell.date.startsWith('2027-01'))).toBe(true);
  });

  it('holds every day of the month exactly once', () => {
    for (const month of [1, 2, 6, 12]) {
      const inMonth = monthGrid(2026, month)
        .flat()
        .filter((cell) => cell.inMonth)
        .map((cell) => cell.day);
      expect(inMonth).toHaveLength(daysInMonth(2026, month));
      expect(new Set(inMonth).size).toBe(inMonth.length);
    }
  });
});

describe('paging', () => {
  it('steps a month and carries the year both ways', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 8, 0)).toEqual({ year: 2026, month: 8 });
    expect(shiftMonth(2026, 1, -13)).toEqual({ year: 2024, month: 12 });
  });

  it('steps a day across a month, a year and a leap day', () => {
    expect(shiftDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDate('2026-08-15', 7)).toBe('2026-08-22');
  });

  it('leaves junk alone rather than inventing a date', () => {
    expect(shiftDate('nonsense', 1)).toBe('nonsense');
  });
});

describe('which days may be chosen', () => {
  /**
   * String comparison, which is exactly right for YYYY-MM-DD: it sorts
   * lexicographically in the same order it sorts chronologically. The rest of
   * the application compares business dates the same way.
   */
  it('refuses anything before the books were locked', () => {
    const bounds = { min: '2026-07-01' };
    expect(isSelectable('2026-06-30', bounds)).toBe(false);
    expect(isSelectable('2026-07-01', bounds)).toBe(true);
    expect(isSelectable('2026-12-31', bounds)).toBe(true);
  });

  it('refuses anything after a ceiling', () => {
    const bounds = { max: '2026-08-29' };
    expect(isSelectable('2026-08-30', bounds)).toBe(false);
    expect(isSelectable('2026-08-29', bounds)).toBe(true);
  });

  it('allows everything when nothing is bounded', () => {
    expect(isSelectable('1999-01-01', {})).toBe(true);
  });

  it('moves an out-of-range date to the nearest day it may be', () => {
    expect(clampToBounds('2026-06-01', { min: '2026-07-01' })).toBe('2026-07-01');
    expect(clampToBounds('2026-09-30', { max: '2026-08-29' })).toBe('2026-08-29');
    expect(clampToBounds('2026-08-15', { min: '2026-07-01', max: '2026-08-29' })).toBe(
      '2026-08-15',
    );
  });

  it('says so rather than guessing when no day is allowed at all', () => {
    expect(clampToBounds('2026-08-15', { min: '2026-09-01', max: '2026-08-01' })).toBeNull();
  });
});

describe('saying the date out loud', () => {
  /** The whole point: 03/04 is unreadable, this is not. */
  it('spells it out so day and month cannot be swapped', () => {
    expect(longDate('2026-04-03')).toBe('Friday, 3 April 2026');
    expect(longDate('2026-03-04')).toBe('Wednesday, 4 March 2026');
  });

  it('returns nothing for junk rather than an invalid date', () => {
    expect(longDate('2026-13-45')).toBe('');
    expect(longDate('')).toBe('');
  });
});

describe('the plumbing', () => {
  it('builds and splits a business date symmetrically', () => {
    expect(toDateString(2026, 4, 3)).toBe('2026-04-03');
    expect(parseParts('2026-04-03')).toEqual({ year: 2026, month: 4, day: 3 });
  });

  it('refuses a date the rest of the app would refuse', () => {
    for (const junk of ['2026-13-45', '26-04-03', '', 'today']) {
      expect(parseParts(junk)).toBeNull();
    }
  });

  it('has twelve month names, in order', () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe('January');
    expect(MONTH_NAMES[11]).toBe('December');
  });
});
