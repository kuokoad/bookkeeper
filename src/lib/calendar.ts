import { isValidBusinessDate } from './format';

/**
 * The arithmetic behind a month grid.
 *
 * Pure, so the awkward parts — a month that starts on a Sunday, a leap year,
 * the week that straddles a year end — are tested without rendering anything.
 * The component in `components/ui/date-field.tsx` only draws what this returns.
 *
 * Everything here speaks the same 'YYYY-MM-DD' business date the rest of the
 * application does, and never a `Date` object across a boundary. A `Date` is an
 * instant with a timezone attached, and reading one back as a calendar day is
 * how a sale rung up at 23:47 lands on the wrong date. See ARCHITECTURE §3.
 */

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export interface CalendarDay {
  /** 'YYYY-MM-DD'. */
  date: string;
  day: number;
  /** False for the leading and trailing days that pad the grid. */
  inMonth: boolean;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Build 'YYYY-MM-DD' from parts. Month is 1-12. */
export function toDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** Split a business date. Returns null rather than throwing on junk. */
export function parseParts(
  value: string,
): { year: number; month: number; day: number } | null {
  if (!isValidBusinessDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

/** How many days February really has this year. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one, and the engine knows
  // about leap years so this file does not have to.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Which column a date falls in, MONDAY first.
 *
 * Ghana's working week starts on Monday and so does the shop's, so a grid that
 * put Sunday first would have the weekend split across both ends. `getUTCDay`
 * counts from Sunday, hence the shift.
 */
export function weekdayIndex(date: string): number {
  const parts = parseParts(date);
  if (parts === null) return 0;
  const sundayFirst = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/**
 * A month as six rows of seven days, padded from the months either side.
 *
 * Always six rows, never five or four. A grid that changed height as you paged
 * through the year would move the buttons under the pointer, and the row you
 * were about to click would not be where you left it.
 */
export function monthGrid(year: number, month: number): CalendarDay[][] {
  const first = toDateString(year, month, 1);
  const lead = weekdayIndex(first);
  const total = daysInMonth(year, month);

  const previousMonth = month === 1 ? 12 : month - 1;
  const previousYear = month === 1 ? year - 1 : year;
  const previousTotal = daysInMonth(previousYear, previousMonth);

  const cells: CalendarDay[] = [];

  for (let index = lead; index > 0; index -= 1) {
    const day = previousTotal - index + 1;
    cells.push({ date: toDateString(previousYear, previousMonth, day), day, inMonth: false });
  }

  for (let day = 1; day <= total; day += 1) {
    cells.push({ date: toDateString(year, month, day), day, inMonth: true });
  }

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let day = 1; cells.length < 42; day += 1) {
    cells.push({ date: toDateString(nextYear, nextMonth, day), day, inMonth: false });
  }

  const weeks: CalendarDay[][] = [];
  for (let index = 0; index < 42; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** Step a month, carrying the year. */
export function shiftMonth(
  year: number,
  month: number,
  by: number,
): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + by;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

/**
 * Move a date by whole days, staying in string space.
 *
 * `Date.UTC` handles the month and year boundaries; going through UTC rather
 * than local time means a machine in a different timezone cannot shift the
 * answer by a day.
 */
export function shiftDate(date: string, byDays: number): string {
  const parts = parseParts(date);
  if (parts === null) return date;
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + byDays));
  return toDateString(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

export interface DateBounds {
  /** Nothing before this may be chosen. Usually the books-lock date. */
  min?: string | undefined;
  max?: string | undefined;
}

/**
 * Whether a day may be chosen.
 *
 * Plain string comparison, which is exactly right for 'YYYY-MM-DD': the format
 * sorts lexicographically in the same order it sorts chronologically, which is
 * why the rest of this application compares dates the same way.
 */
export function isSelectable(date: string, bounds: DateBounds): boolean {
  if (bounds.min !== undefined && date < bounds.min) return false;
  if (bounds.max !== undefined && date > bounds.max) return false;
  return true;
}

/** The nearest selectable day to a target, or null when the range is empty. */
export function clampToBounds(date: string, bounds: DateBounds): string | null {
  if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) return null;
  if (bounds.min !== undefined && date < bounds.min) return bounds.min;
  if (bounds.max !== undefined && date > bounds.max) return bounds.max;
  return date;
}

/** "Friday, 3 April 2026". What kills the 03/04 ambiguity. */
export function longDate(value: string): string {
  const parts = parseParts(value);
  if (parts === null) return '';
  const at = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    at.getUTCDay()
  ];
  return `${weekday}, ${parts.day} ${MONTH_NAMES[parts.month - 1]} ${parts.year}`;
}
