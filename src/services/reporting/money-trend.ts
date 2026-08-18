import { and, asc, gte, inArray, lte, sql } from 'drizzle-orm';

import { accounts, journalEntries, journalLines, paymentAccounts } from '@/db/schema';
import type { Db } from '@/db/types';
import { minor, type Minor } from '@/domain/money';

/**
 * Money in and money out, per month, for the dashboard's cash flow chart.
 *
 * One grouped query rather than a call per month. The dashboard is the screen
 * the owner opens most often, and a chart that costs six aggregates over the
 * whole ledger would be the slowest thing on it within a year of trading.
 *
 * "Money" means the accounts that actually hold it — the general ledger
 * accounts behind the shop's cash, mobile money and bank accounts. A debit to
 * one of those is money arriving; a credit is money leaving.
 */

export interface MoneyMonth {
  /** 'YYYY-MM'. */
  month: string;
  /** Short label for an axis, e.g. 'Mar'. */
  label: string;
  inMinor: Minor;
  outMinor: Minor;
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The `count` months ending with the one containing `endDate`, oldest first. */
function monthsEnding(endDate: string, count: number): string[] {
  const year = Number(endDate.slice(0, 4));
  const month = Number(endDate.slice(5, 7));

  const months: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    // Arithmetic on a month index rather than Date, which would drag a
    // timezone into a figure that is purely a business calendar.
    const index = year * 12 + (month - 1) - back;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return months;
}

export function getMoneyByMonth(db: Db, endDate: string, count = 6): MoneyMonth[] {
  const months = monthsEnding(endDate, count);
  const from = `${months[0]}-01`;
  // Inclusive of the whole final month; '-32' sorts after any real day.
  const to = `${months[months.length - 1]}-32`;

  const moneyAccountIds = db
    .select({ id: paymentAccounts.glAccountId })
    .from(paymentAccounts)
    .all()
    .map((row) => row.id);

  const empty = months.map((month) => ({
    month,
    label: MONTH_LABELS[Number(month.slice(5, 7)) - 1] ?? month,
    inMinor: minor(0),
    outMinor: minor(0),
  }));

  if (moneyAccountIds.length === 0) return empty;

  const rows = db
    .select({
      month: sql<string>`substr(${journalEntries.entryDate}, 1, 7)`,
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, sql`${journalEntries.id} = ${journalLines.entryId}`)
    .innerJoin(accounts, sql`${accounts.id} = ${journalLines.accountId}`)
    .where(
      and(
        inArray(journalLines.accountId, moneyAccountIds),
        gte(journalEntries.entryDate, from),
        lte(journalEntries.entryDate, to),
      ),
    )
    .groupBy(sql`substr(${journalEntries.entryDate}, 1, 7)`)
    .orderBy(asc(sql`substr(${journalEntries.entryDate}, 1, 7)`))
    .all();

  const byMonth = new Map(rows.map((row) => [row.month, row]));

  return empty.map((month) => {
    const found = byMonth.get(month.month);
    return {
      ...month,
      inMinor: minor(found?.debit ?? 0),
      outMinor: minor(found?.credit ?? 0),
    };
  });
}
