import { ValidationError } from '@/domain/errors';
import { assertPeriodOpen } from '@/domain/accounting/period-lock';

/**
 * Which day a sale may be recorded on.
 *
 * Today, always. An earlier day only for somebody trusted to backdate, and
 * never a day inside the books lock or after today.
 *
 * Backdating is gated because it is the quiet way to move a sale out of the
 * period somebody is looking at. The books still balance and the stock still
 * moves, so nothing downstream would ever notice; the decision has to be made
 * before the sale is written. The till takes the right from `sales:edit`, the
 * same right as setting a price, for the same reason. Owners always hold it.
 *
 * A future date is refused for everyone. A sale that has not happened yet is
 * not a sale.
 *
 * The journal enforces the lock again on every posting. Checking it here as
 * well means the cashier is told before anything is attempted.
 */
export function assertSaleDateAllowed(
  businessDate: string,
  rules: { today: string; lockedBefore: string | null; mayBackdate: boolean },
): void {
  if (businessDate > rules.today) {
    throw new ValidationError('A sale cannot be dated in the future.');
  }
  if (businessDate === rules.today) return;

  if (!rules.mayBackdate) {
    throw new ValidationError('Only an owner or manager can record a sale on an earlier day.');
  }
  assertPeriodOpen(businessDate, rules.lockedBefore);
}
