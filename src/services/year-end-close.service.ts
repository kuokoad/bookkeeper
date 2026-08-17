import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

import { accounts, businessSettings, journalEntries, yearEndClosings } from '@/db/schema';
import type { Db, Tx } from '@/db/types';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { financialYear, financialYearFor, type FinancialYear } from '@/domain/financial-year';
import {
  buildClosingEntry,
  type ClosableAccount,
} from '@/domain/accounting/year-end-close';
import { minor, type Minor } from '@/domain/money';
import { postJournalEntry, reverseJournalEntry } from '@/services/journal.service';
import { getAccountBalances } from '@/services/reporting/balances.service';
import { getSettings } from '@/services/settings.service';
import { writeAudit } from '@/services/audit.service';
import { toBusinessDate } from '@/lib/format';

/**
 * Closing and reopening a financial year.
 *
 * Closing posts one journal entry that zeroes the year's revenue, expense and
 * drawings accounts and carries the result to Retained Earnings. Reopening does
 * not delete it — it posts a reversal, and the closing record keeps both.
 */

export interface Actor {
  id: number;
  username: string;
}

export interface ClosingRecord {
  id: number;
  startYear: number;
  label: string;
  periodStart: string;
  periodEnd: string;
  journalEntryId: number;
  profit: Minor;
  drawings: Minor;
  closedAt: Date;
  closedByUsername: string | null;
  reversedAt: Date | null;
}

/** Accounts to be swept, with their balance for the year. */
interface ClosableSets {
  revenue: ClosableAccount[];
  expenses: ClosableAccount[];
  drawings: ClosableAccount[];
}

function collectClosable(db: Db | Tx, year: FinancialYear, includeDrawings: boolean): ClosableSets {
  // Balances for the year only, and never counting a closing entry — otherwise
  // closing twice would sweep the previous sweep.
  const balances = getAccountBalances(db as Db, {
    from: year.start,
    to: year.end,
    excludeClosing: true,
  }).filter((account) => !account.isHeader);

  const asClosable = (account: (typeof balances)[number]): ClosableAccount => ({
    accountId: account.accountId,
    code: account.code,
    name: account.name,
    balance: account.balance,
  });

  return {
    // Contra-revenue — discounts given and goods returned — belongs with
    // revenue. Its balance is negative, and `closeOut` handles the side.
    revenue: balances
      .filter((account) => account.type === 'REVENUE' || account.type === 'CONTRA_REVENUE')
      .map(asClosable),
    expenses: balances
      .filter((account) => account.type === 'EXPENSE' || account.type === 'COGS')
      .map(asClosable),
    drawings: includeDrawings
      ? balances
          .filter((account) => account.code === ACCOUNT_CODES.OWNERS_DRAWINGS)
          .map(asClosable)
      : [],
  };
}

function accountIdByCode(db: Db | Tx, code: string): number {
  const account = db.select().from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

/** The open (not reversed) closing for a year, if there is one. */
function openClosing(db: Db | Tx, startYear: number) {
  return db
    .select()
    .from(yearEndClosings)
    .where(and(eq(yearEndClosings.startYear, startYear), isNull(yearEndClosings.reversedAt)))
    .get();
}

export function isYearClosed(db: Db, startYear: number): boolean {
  return openClosing(db, startYear) !== undefined;
}

/** Every close ever made, newest first, reversed ones included. */
export function listClosings(db: Db): ClosingRecord[] {
  const startMonth = getSettings(db).financialYearStartMonth;

  return db
    .select()
    .from(yearEndClosings)
    .orderBy(sql`${yearEndClosings.startYear} DESC`)
    .all()
    .map((row) => ({
      id: row.id,
      startYear: row.startYear,
      label: financialYear(row.startYear, startMonth).label,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      journalEntryId: row.journalEntryId,
      profit: minor(row.profitMinor),
      drawings: minor(row.drawingsMinor),
      closedAt: row.closedAt,
      closedByUsername: null,
      reversedAt: row.reversedAt,
    }));
}

export interface CloseResult {
  entryId: number;
  entryNo: string;
  profit: Minor;
  drawings: Minor;
  lineCount: number;
}

/**
 * Closes a financial year.
 *
 * Refuses when: the year is already closed, an earlier year is still open, or
 * the year has not finished. Each of those would produce figures that look
 * final and are not.
 */
export function closeFinancialYear(db: Db, startYear: number, actor: Actor): CloseResult {
  return db.transaction((tx) => {
    const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    if (!settings) throw new NotFoundError('Business settings', 1);

    const year = financialYear(startYear, settings.financialYearStartMonth);

    if (openClosing(tx, startYear)) {
      throw new ConflictError(`The year ${year.label} is already closed.`);
    }

    // A year cannot end before it has finished; the figures would not be final.
    if (toBusinessDate() <= year.end) {
      throw new ValidationError(
        `The year ${year.label} has not finished yet — it ends ${year.end}. Closing it now would make provisional figures look final.`,
      );
    }

    // Years must close in order. Closing 2026 while 2025 is open would sweep
    // 2025's profit nowhere and leave the sequence impossible to reason about.
    const earliestEntry = tx
      .select({ date: sql<string | null>`MIN(${journalEntries.entryDate})` })
      .from(journalEntries)
      .get()?.date;

    if (earliestEntry) {
      const firstYear = financialYearFor(earliestEntry, settings.financialYearStartMonth);
      for (let previous = firstYear.startYear; previous < startYear; previous++) {
        if (!openClosing(tx, previous)) {
          const label = financialYear(previous, settings.financialYearStartMonth).label;
          throw new ConflictError(
            `Close ${label} first. Years must be closed in order, oldest first.`,
          );
        }
      }
    }

    const closable = collectClosable(tx, year, true);
    const entry = buildClosingEntry({
      ...closable,
      retainedEarningsAccountId: accountIdByCode(tx, ACCOUNT_CODES.RETAINED_EARNINGS),
    });

    const posted = postJournalEntry(
      tx,
      {
        entryDate: year.end,
        sourceType: 'YEAR_END_CLOSE',
        memo: `Year-end close for ${year.label}`,
        lines: entry.lines,
        isClosing: true,
        // The lock is set to this year end below, and the entry is dated on it.
        // It has to be allowed past the very lock it is about to create.
        overridePeriodLock: true,
      },
      actor,
    );

    const now = new Date();
    tx.insert(yearEndClosings)
      .values({
        startYear,
        periodStart: year.start,
        periodEnd: year.end,
        journalEntryId: posted.entryId,
        profitMinor: entry.profit,
        drawingsMinor: entry.totalDrawings,
        closedBy: actor.id,
        closedAt: now,
      })
      .run();

    // Closing without locking would let someone date a sale into a year whose
    // figures have just been declared final.
    tx.update(businessSettings)
      .set({ booksLockedBefore: year.end, updatedAt: now })
      .where(eq(businessSettings.id, 1))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'year_end_closing',
      entityId: posted.entryId,
      userId: actor.id,
      username: actor.username,
      summary:
        `Closed the year ${year.label}: profit ${(entry.profit / 100).toFixed(2)}, ` +
        `drawings ${(entry.totalDrawings / 100).toFixed(2)}. Books locked to ${year.end}.`,
      at: now,
    });

    return {
      entryId: posted.entryId,
      entryNo: posted.entryNo,
      profit: entry.profit,
      drawings: entry.totalDrawings,
      lineCount: entry.lines.length,
    };
  });
}

/**
 * Reopens a closed year by reversing its closing entry.
 *
 * Nothing is deleted: the original close and its reversal both remain, and the
 * closing record keeps the link. The books lock is moved back to the end of the
 * previous closed year, since the year being reopened must accept entries again.
 */
export function reopenFinancialYear(db: Db, startYear: number, actor: Actor): void {
  db.transaction((tx) => {
    const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    if (!settings) throw new NotFoundError('Business settings', 1);

    const year = financialYear(startYear, settings.financialYearStartMonth);
    const closing = openClosing(tx, startYear);
    if (!closing) throw new ConflictError(`The year ${year.label} is not closed.`);

    // A later closed year sits on top of this one: its figures were computed
    // with this year already swept. Reopening underneath would strand them.
    const laterClosed = tx
      .select()
      .from(yearEndClosings)
      .where(and(isNull(yearEndClosings.reversedAt), sql`${yearEndClosings.startYear} > ${startYear}`))
      .get();

    if (laterClosed) {
      const label = financialYear(laterClosed.startYear, settings.financialYearStartMonth).label;
      throw new ConflictError(`Reopen ${label} first. Years must be reopened newest first.`);
    }

    const now = new Date();
    const reversal = reverseJournalEntry(
      tx,
      closing.journalEntryId,
      {
        entryDate: year.end,
        memo: `Reopened the year ${year.label}`,
        sourceType: 'YEAR_END_CLOSE',
        occurredAt: now,
        // The reversal is dated on the year end, which is exactly the lock the
        // close put in place. Undoing something must not be blocked by the
        // thing it is undoing.
        overridePeriodLock: true,
        // Marked as closing too: it is dated inside the year, and unless the
        // Profit & Loss leaves it out the year's profit is reported twice.
        isClosing: true,
      },
      actor,
    );

    tx.update(yearEndClosings)
      .set({ reversedAt: now, reversedBy: actor.id, reversalEntryId: reversal.entryId })
      .where(eq(yearEndClosings.id, closing.id))
      .run();

    // Move the lock back to the end of the newest year still closed, or remove
    // it entirely when none are.
    const previousClosed = tx
      .select()
      .from(yearEndClosings)
      .where(and(isNull(yearEndClosings.reversedAt), lte(yearEndClosings.startYear, startYear)))
      .orderBy(asc(yearEndClosings.startYear))
      .all()
      .at(-1);

    tx.update(businessSettings)
      .set({ booksLockedBefore: previousClosed?.periodEnd ?? null, updatedAt: now })
      .where(eq(businessSettings.id, 1))
      .run();

    writeAudit(tx, {
      action: 'REVERSE',
      entityType: 'year_end_closing',
      entityId: closing.id,
      userId: actor.id,
      username: actor.username,
      summary:
        `REOPENED the year ${year.label}. The closing entry was reversed, and the books ` +
        `lock moved back to ${previousClosed?.periodEnd ?? 'nothing'}.`,
      at: now,
    });
  });
}
