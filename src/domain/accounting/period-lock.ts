import { DomainError } from '../errors';

/**
 * The books lock.
 *
 * A shop with staff needs one control that a single-owner shop does not: once a
 * period has been reviewed, nobody should be able to quietly change it. Without
 * this, a sale back-dated to last month silently rewrites last month's reported
 * profit AND this month's opening position, and nothing in the audit trail says
 * the figures moved.
 *
 * Deliberately NOT an accounting close. Nothing is zeroed and no closing entry
 * is posted; the lock only refuses new activity dated into a closed period.
 * Corrections stay possible the way proper practice requires — by posting a
 * current-dated reversal, which is visible rather than invisible.
 */

export class PeriodLockedError extends DomainError {
  constructor(businessDate: string, lockedBefore: string) {
    super(
      'CONFLICT',
      `Period locked: ${businessDate} is on or before the lock date ${lockedBefore}`,
      `The books are closed up to ${formatForUser(lockedBefore)}. ` +
        `You cannot record anything dated ${formatForUser(businessDate)}. ` +
        'Use a later date, or ask the owner to move the lock.',
      { businessDate, lockedBefore },
    );
  }
}

function formatForUser(businessDate: string): string {
  const [year, month, day] = businessDate.split('-');
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const monthName = months[Number(month) - 1] ?? month;
  return `${day} ${monthName} ${year}`;
}

/**
 * True when a transaction on `businessDate` may be recorded.
 *
 * The lock is INCLUSIVE: setting it to 2026-07-31 closes everything up to and
 * including that day, so the owner can lock "the end of July" using the date
 * they would say out loud.
 */
export function isPeriodOpen(businessDate: string, lockedBefore: string | null): boolean {
  if (lockedBefore === null) return true;
  return businessDate > lockedBefore;
}

/** Throws PeriodLockedError unless the date is in an open period. */
export function assertPeriodOpen(
  businessDate: string,
  lockedBefore: string | null,
  options: { allowOverride?: boolean } = {},
): void {
  if (options.allowOverride === true) return;
  if (isPeriodOpen(businessDate, lockedBefore)) return;
  throw new PeriodLockedError(businessDate, lockedBefore as string);
}

/**
 * Moving the lock forward is routine; moving it BACKWARD reopens a period that
 * was declared final, so it is a separate, deliberate act.
 */
export function isLockRelaxation(current: string | null, next: string | null): boolean {
  if (current === null) return false;
  if (next === null) return true;
  return next < current;
}
