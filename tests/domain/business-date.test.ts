import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, daysOverdue, dueDateFor } from '@/domain/business-date';
import { ValidationError } from '@/domain/errors';

describe('adding days', () => {
  it('moves within a month', () => {
    expect(addDays('2026-08-10', 5)).toBe('2026-08-15');
  });

  it('crosses a month end', () => {
    expect(addDays('2026-08-30', 5)).toBe('2026-09-04');
  });

  it('crosses a year end', () => {
    expect(addDays('2026-12-20', 30)).toBe('2027-01-19');
  });

  it('handles the short months', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
  });

  it('gets February right in a common year', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('gets February right in a leap year', () => {
    // 2028 is a leap year: the 29th exists.
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('handles century rules', () => {
    // 1900 was not a leap year; 2000 was.
    expect(addDays('1900-02-28', 1)).toBe('1900-03-01');
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
  });

  it('moves backwards with a negative number', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('adding nothing changes nothing', () => {
    expect(addDays('2026-08-17', 0)).toBe('2026-08-17');
  });

  it('survives a long span', () => {
    // A year of 30-day terms, one after another.
    let date = '2026-01-01';
    for (let month = 0; month < 12; month++) date = addDays(date, 30);
    expect(date).toBe('2026-12-27');
  });
});

describe('counting days between', () => {
  it('counts forwards', () => {
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(30);
  });

  it('is zero for the same day', () => {
    expect(daysBetween('2026-08-17', '2026-08-17')).toBe(0);
  });

  it('is negative going backwards', () => {
    expect(daysBetween('2026-08-31', '2026-08-01')).toBe(-30);
  });

  it('counts across a leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('is the exact inverse of adding', () => {
    for (const days of [0, 1, 7, 30, 45, 365, 400]) {
      const later = addDays('2026-08-17', days);
      expect(daysBetween('2026-08-17', later), String(days)).toBe(days);
    }
  });
});

describe('when payment falls due', () => {
  it('is the sale date plus the terms', () => {
    expect(dueDateFor('2026-08-17', 30)).toBe('2026-09-16');
    expect(dueDateFor('2026-08-17', 7)).toBe('2026-08-24');
  });

  it('due on receipt means the same day, not the next', () => {
    expect(dueDateFor('2026-08-17', 0)).toBe('2026-08-17');
  });

  it('refuses nonsense terms', () => {
    for (const terms of [-1, 1.5, 366]) {
      expect(() => dueDateFor('2026-08-17', terms), String(terms)).toThrow(ValidationError);
    }
  });
});

describe('how overdue something is', () => {
  it('is zero on the due date itself', () => {
    // Due today is not yet overdue.
    expect(daysOverdue('2026-08-17', '2026-08-17')).toBe(0);
  });

  it('counts days past the due date', () => {
    expect(daysOverdue('2026-08-17', '2026-08-20')).toBe(3);
  });

  it('is negative before it is due', () => {
    expect(daysOverdue('2026-09-16', '2026-08-17')).toBe(-30);
  });
});

describe('refusing what is not a date', () => {
  it('rejects the wrong shape', () => {
    for (const bad of ['17/08/2026', '2026-8-17', '', 'today', '2026-08']) {
      expect(() => addDays(bad, 1), bad).toThrow(ValidationError);
    }
  });

  it('rejects a day that does not exist', () => {
    // The classic: 30 February, and the 29th in a non-leap year.
    expect(() => addDays('2026-02-30', 1)).toThrow(ValidationError);
    expect(() => addDays('2026-02-29', 1)).toThrow(ValidationError);
    expect(() => addDays('2026-13-01', 1)).toThrow(ValidationError);
    expect(() => addDays('2026-04-31', 1)).toThrow(ValidationError);
  });

  it('accepts the 29th in a leap year', () => {
    expect(() => addDays('2028-02-29', 1)).not.toThrow();
  });
});
