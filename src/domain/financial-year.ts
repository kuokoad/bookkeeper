import { ValidationError } from './errors';

/**
 * Financial years.
 *
 * A shop's year need not start in January — Ghana commonly uses January, but
 * the month is a setting, and an accountant asking for "the 2025 accounts"
 * means whatever twelve months this shop calls 2025.
 *
 * All arithmetic here is on `YYYY-MM-DD` strings rather than `Date` objects.
 * A `Date` carries a time and a timezone, and a business day does not: parsing
 * "2025-12-31" in a timezone behind UTC yields the 30th, which would put a
 * year-end sale in the wrong year.
 */

export interface FinancialYear {
  /** First day, inclusive. */
  start: string;
  /** Last day, inclusive. */
  end: string;
  /** "2025" for a January start, "2025/26" otherwise. */
  label: string;
  /** The calendar year the period starts in — how a year is identified here. */
  startYear: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { year: number; month: number; day: number } {
  const match = DATE.exec(date);
  if (!match) throw new ValidationError(`"${date}" is not a business date.`, { date });
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** Days in a month, February included, without constructing a Date. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new ValidationError('The financial year must start in a month from 1 to 12.', {
      startMonth,
    });
  }
}

/**
 * The financial year identified by the calendar year it *starts* in.
 *
 * With a January start, 2025 is simply 2025. With an April start, 2025 runs
 * 1 April 2025 to 31 March 2026 — the convention accountants use when they say
 * "FY 2025/26".
 */
export function financialYear(startYear: number, startMonth: number): FinancialYear {
  assertStartMonth(startMonth);
  if (!Number.isInteger(startYear) || startYear < 1900 || startYear > 9999) {
    throw new ValidationError(`"${startYear}" is not a year.`, { startYear });
  }

  const start = `${startYear}-${pad(startMonth)}-01`;

  // The last day is the day before the same date a year later, which lands on
  // the end of the preceding month — 31 March for an April start.
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const end = `${endYear}-${pad(endMonth)}-${pad(daysInMonth(endYear, endMonth))}`;

  const label = startMonth === 1 ? String(startYear) : `${startYear}/${pad((startYear + 1) % 100)}`;

  return { start, end, label, startYear };
}

/** The financial year a given business date falls inside. */
export function financialYearFor(date: string, startMonth: number): FinancialYear {
  assertStartMonth(startMonth);
  const { year, month } = parts(date);

  // Before the start month, the date still belongs to the year that began the
  // previous calendar year.
  const startYear = month >= startMonth ? year : year - 1;
  return financialYear(startYear, startMonth);
}

/** The financial year immediately before this one — the comparative column. */
export function previousFinancialYear(year: FinancialYear, startMonth: number): FinancialYear {
  return financialYear(year.startYear - 1, startMonth);
}

/**
 * Every financial year with activity, newest first.
 *
 * Derived from the dates actually in the books rather than from a fixed span,
 * so the list never offers a year the shop was not trading in.
 */
export function financialYearsBetween(
  earliest: string,
  latest: string,
  startMonth: number,
): FinancialYear[] {
  assertStartMonth(startMonth);

  const first = financialYearFor(earliest, startMonth);
  const last = financialYearFor(latest, startMonth);

  const years: FinancialYear[] = [];
  for (let startYear = last.startYear; startYear >= first.startYear; startYear--) {
    years.push(financialYear(startYear, startMonth));
  }
  return years;
}

/** Whether a business date falls within the year, both ends inclusive. */
export function isWithin(date: string, year: FinancialYear): boolean {
  return date >= year.start && date <= year.end;
}
