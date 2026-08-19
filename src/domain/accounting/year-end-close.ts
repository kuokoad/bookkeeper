import { minor, sum, type Minor } from '../money';
import { ValidationError } from '../errors';
import type { DraftLine } from './journal';
import { credit, debit } from './journal';

/**
 * Building the year-end closing entry.
 *
 * Closing sweeps the year's revenue and expense accounts back to zero and
 * carries what is left — the profit — into Retained Earnings. Drawings go the
 * same way, so each year starts with a clean slate rather than an ever-growing
 * contra balance.
 *
 * Pure: it is handed the balances and returns the lines. Nothing here reads the
 * database, so every case below is testable without one.
 */

export interface ClosableAccount {
  accountId: number;
  code: string;
  name: string;
  /**
   * The account's balance for the year, sign-adjusted for its type — the same
   * `balance` the reporting services produce. Positive means the account
   * carries its natural side: revenue earned, or expense incurred.
   */
  balance: Minor;
}

export interface ClosingInput {
  /** Revenue and other income. Credit-normal. */
  revenue: ClosableAccount[];
  /**
   * Discounts given and goods returned. Kept apart from `revenue` because they
   * are DEBIT-normal: giving GHS 100 away shows as a positive 100 here, and a
   * positive figure in with the revenue would be added to the year's takings
   * instead of taken off. Lumped in, a shop would be told that discounting made
   * it money, and the closing entry would debit the account a second time
   * rather than clear it.
   */
  contraRevenue: ClosableAccount[];
  /** Cost of goods sold and every expense. */
  expenses: ClosableAccount[];
  /** Owner's drawings for the year, if they are being closed too. */
  drawings: ClosableAccount[];

  retainedEarningsAccountId: number;
}

export interface ClosingEntry {
  lines: DraftLine[];
  /** Revenue less expenses. Negative for a loss. */
  profit: Minor;
  /** Net: sold, less discounts given and goods returned. */
  totalRevenue: Minor;
  /** Sold before anything was given back. */
  grossRevenue: Minor;
  totalContraRevenue: Minor;
  totalExpenses: Minor;
  totalDrawings: Minor;
  /** What Retained Earnings moves by: profit less drawings. */
  netToRetainedEarnings: Minor;
}

/**
 * Reverses an account's balance so it ends the year at zero.
 *
 * A revenue account carries a credit balance, so it is closed with a debit of
 * the same size, and the other way round for an expense. The amount is always
 * positive on the line — the side carries the direction.
 */
function closeOut(account: ClosableAccount, naturalSide: 'credit' | 'debit'): DraftLine | null {
  if (account.balance === 0) return null;

  // A negative balance means the account is carrying the opposite of its
  // natural side — a revenue account in debit, say, after heavy returns. It
  // still has to be zeroed, just from the other direction.
  const amount = minor(Math.abs(account.balance));
  const closeWithDebit = naturalSide === 'credit' ? account.balance > 0 : account.balance < 0;

  const description = `Close ${account.name} for the year`;
  return closeWithDebit
    ? debit(account.accountId, amount, { description })
    : credit(account.accountId, amount, { description });
}

export function buildClosingEntry(input: ClosingInput): ClosingEntry {
  const lines: DraftLine[] = [];

  for (const account of input.revenue) {
    const line = closeOut(account, 'credit');
    if (line) lines.push(line);
  }
  // Debit-normal, so closing it means crediting it back to zero.
  for (const account of input.contraRevenue) {
    const line = closeOut(account, 'debit');
    if (line) lines.push(line);
  }
  for (const account of input.expenses) {
    const line = closeOut(account, 'debit');
    if (line) lines.push(line);
  }
  for (const account of input.drawings) {
    const line = closeOut(account, 'debit');
    if (line) lines.push(line);
  }

  const grossRevenue = sum(input.revenue.map((account) => account.balance));
  const totalContraRevenue = sum(input.contraRevenue.map((account) => account.balance));
  // What the shop actually earned: sold, less given away and brought back.
  const totalRevenue = minor(grossRevenue - totalContraRevenue);
  const totalExpenses = sum(input.expenses.map((account) => account.balance));
  const totalDrawings = sum(input.drawings.map((account) => account.balance));

  const profit = minor(totalRevenue - totalExpenses);
  const netToRetainedEarnings = minor(profit - totalDrawings);

  if (lines.length === 0) {
    throw new ValidationError(
      'There is nothing to close: no revenue, expenses or drawings were recorded in this year.',
    );
  }

  // The balancing line. Retained Earnings is credited with a profit and debited
  // with a loss; drawings pull it the other way.
  if (netToRetainedEarnings !== 0) {
    const amount = minor(Math.abs(netToRetainedEarnings));
    lines.push(
      netToRetainedEarnings > 0
        ? credit(input.retainedEarningsAccountId, amount, {
            description: 'Profit for the year, less drawings',
          })
        : debit(input.retainedEarningsAccountId, amount, {
            description: 'Loss for the year, plus drawings',
          }),
    );
  }

  return {
    lines,
    profit,
    totalRevenue,
    grossRevenue,
    totalContraRevenue,
    totalExpenses,
    totalDrawings,
    netToRetainedEarnings,
  };
}
