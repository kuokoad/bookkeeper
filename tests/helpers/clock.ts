import { daysInMonth } from '@/domain/financial-year';
import { toBusinessDate } from '@/lib/format';

/**
 * The month the test is actually running in.
 *
 * Some services date what they write from the clock rather than from an
 * argument, and they are right to: a void, a return and a stock correction all
 * belong to the day somebody made them, never to the day of the document being
 * corrected. That is the rule the reports are built around.
 *
 * A test that posts a sale on a fixed date and then cancels it therefore
 * straddles two periods, and the period holding the correction is whichever
 * month the suite is being run in. Writing that month as a literal made three
 * tests pass for as long as the literal happened to be the current month and
 * fail on the first of the next one — which is what happened on 1 September
 * 2026. The assertions were right; only the window was stale.
 *
 * So the window is derived, and the tests keep asserting exactly what they did
 * before: the correction lands in the month it was made, and the pair nets to
 * nothing across all time.
 */
export function thisMonth(): { from: string; to: string } {
  return monthOf(toBusinessDate());
}

/** The calendar month containing `date`, inclusive at both ends. */
export function monthOf(date: string): { from: string; to: string } {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const last = String(daysInMonth(year, month)).padStart(2, '0');
  return { from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-${last}` };
}
