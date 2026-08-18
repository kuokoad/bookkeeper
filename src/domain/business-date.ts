import { ValidationError } from './errors';
import { daysInMonth } from './financial-year';

/**
 * Arithmetic on business days.
 *
 * A business date is `YYYY-MM-DD` in the shop's own calendar, with no time and
 * no timezone. Doing this with `Date` is where quiet errors come from: parsing
 * "2025-12-31" west of UTC yields the 30th, and adding 30 days across a
 * daylight-saving boundary can land an hour short and round down a day. A due
 * date that is one day out is the difference between an invoice being overdue
 * and not.
 *
 * So the arithmetic is done on the numbers themselves.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Parts {
  year: number;
  month: number;
  day: number;
}

function parse(date: string): Parts {
  const match = DATE.exec(date);
  if (!match) throw new ValidationError(`"${date}" is not a business date.`, { date });

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new ValidationError(`"${date}" has no such month.`, { date });
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new ValidationError(`"${date}" is not a real day.`, { date });
  }
  return { year, month, day };
}

const format = ({ year, month, day }: Parts): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Days since an arbitrary fixed point. Only differences of these are used. */
function toDayNumber({ year, month, day }: Parts): number {
  // Shift so leap days fall at the end of the cycle, which removes the special
  // case for February entirely.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthShifted = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * monthShifted + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra;
}

function fromDayNumber(dayNumber: number): Parts {
  const era = Math.floor(dayNumber / 146_097);
  const dayOfEra = dayNumber - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthShifted = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthShifted + 2) / 5) + 1;
  const month = monthShifted < 10 ? monthShifted + 3 : monthShifted - 9;
  return { year: month <= 2 ? year + 1 : year, month, day };
}

/** `days` after `date`. Negative moves backwards. */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new ValidationError('Days must be a whole number.', { days });
  }
  return format(fromDayNumber(toDayNumber(parse(date)) + days));
}

/** How many days `later` is after `earlier`. Negative if it is before. */
export function daysBetween(earlier: string, later: string): number {
  return toDayNumber(parse(later)) - toDayNumber(parse(earlier));
}

/**
 * The day payment falls due.
 *
 * Terms of zero mean due on receipt — the same day, not the next.
 */
export function dueDateFor(businessDate: string, termsDays: number): string {
  if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 365) {
    throw new ValidationError('Payment terms must be between 0 and 365 days.', { termsDays });
  }
  return addDays(businessDate, termsDays);
}

/** Days past due as at `asAt`. Zero or negative means not yet due. */
export function daysOverdue(dueDate: string, asAt: string): number {
  return daysBetween(dueDate, asAt);
}
