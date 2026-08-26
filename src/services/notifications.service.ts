import { eq, sql } from 'drizzle-orm';

import { auditLogs, businessSettings } from '@/db/schema';
import type { Db } from '@/db/types';
import { can, type Principal } from '@/lib/auth/permissions';
import { toBusinessDate } from '@/lib/format';
import { financialYearFor } from '@/domain/financial-year';
import { getExpirySummary, getStockSummary } from '@/services/catalog.service';
import { describeBackupStatus, getBackupStatus } from './backup.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { getReceivablesAgeing } from '@/services/reporting/ledger.service';
import { isYearClosed } from '@/services/year-end-close.service';

/**
 * Things that genuinely need the owner's attention.
 *
 * Every notice below is a condition that holds right now, derived from the
 * ledger — never a suggestion, a tip, or a nudge. A bell that cries wolf gets
 * ignored, and the one time it matters (books out of balance) it would be
 * ignored too.
 *
 * Filtered by permission: a notice a person cannot act on is noise to them, and
 * some of these would disclose figures they are not allowed to see.
 */

export interface Notice {
  id: string;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  detail: string;
  href: string;
}

export function getNotices(db: Db, user: Principal): Notice[] {
  const notices: Notice[] = [];
  const today = toBusinessDate();

  // The one that must never be missed. Everyone sees it: if the books do not
  // balance, nothing else on any screen can be trusted.
  const trial = getTrialBalance(db);
  if (!trial.balanced) {
    notices.push({
      id: 'unbalanced',
      tone: 'danger',
      title: 'The books do not balance',
      detail: 'Stop recording and report this.',
      href: '/accounting',
    });
  }

  if (can(user, 'products', 'view')) {
    const stock = getStockSummary(db);
    if (stock.outOfStockCount > 0) {
      notices.push({
        id: 'out-of-stock',
        tone: 'danger',
        title: `${stock.outOfStockCount} product${stock.outOfStockCount === 1 ? '' : 's'} out of stock`,
        detail: 'Nothing left to sell.',
        href: '/products?low=1',
      });
    } else if (stock.lowStockCount > 0) {
      notices.push({
        id: 'low-stock',
        tone: 'warning',
        title: `${stock.lowStockCount} product${stock.lowStockCount === 1 ? '' : 's'} running low`,
        detail: 'Time to reorder.',
        href: '/products?low=1',
      });
    }

    /**
     * Dates, on the same footing as quantity and with the same precedence:
     * stock that has already turned crowds out the warning about stock that is
     * going to, exactly as out-of-stock crowds out running-low. Two notices
     * about the same shelf is one notice too many.
     *
     * Both are conditions holding right now, read from the batches. Neither is
     * a nudge, and neither appears at all in a shop that never dates anything.
     */
    const expiry = getExpirySummary(db, today);
    if (expiry.expiredCount > 0) {
      notices.push({
        id: 'expired-stock',
        tone: 'danger',
        title: `${expiry.expiredCount} product${expiry.expiredCount === 1 ? '' : 's'} with expired stock`,
        detail: 'It cannot be sold. Write it off to take it out of the accounts.',
        href: '/products?expiring=expired',
      });
    } else if (expiry.expiringSoonCount > 0) {
      notices.push({
        id: 'expiring-soon',
        tone: 'warning',
        /**
         * The number of days is only named when every product counted agrees
         * on it. Once one sets its own window there is no single figure to
         * quote, and "expiring within 30 days" would be false for the very
         * product that made somebody set a shorter one.
         */
        title: expiry.uniformWindow
          ? `${expiry.expiringSoonCount} product${expiry.expiringSoonCount === 1 ? '' : 's'} expiring within ${expiry.warningDays} days`
          : `${expiry.expiringSoonCount} product${expiry.expiringSoonCount === 1 ? '' : 's'} expiring soon`,
        detail: 'Still sellable. Move it first.',
        href: '/products?expiring=soon',
      });
    }
  }

  if (can(user, 'customers', 'view')) {
    const overdueCustomers = getReceivablesAgeing(db, today).filter(
      (row) => row.days31to60 + row.days61to90 + row.over90 > 0,
    );
    if (overdueCustomers.length > 0) {
      notices.push({
        id: 'overdue',
        tone: 'warning',
        title: `${overdueCustomers.length} customer${overdueCustomers.length === 1 ? '' : 's'} owing over 30 days`,
        detail: 'Worth a reminder.',
        href: '/accounting/receivables',
      });
    }
  }

  // Owner-level housekeeping below.
  if (can(user, 'settings', 'edit')) {
    const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

    if (settings) {
      // A finished year that has not been closed.
      const lastYear = financialYearFor(today, settings.financialYearStartMonth).startYear - 1;
      const hasEntries =
        (db.select({ n: sql<number>`COUNT(*)` }).from(auditLogs).get()?.n ?? 0) > 0;

      if (hasEntries && !isYearClosed(db, lastYear)) {
        notices.push({
          id: 'year-open',
          tone: 'info',
          title: 'Last financial year is not closed',
          detail: 'Closing it fixes the figures and locks the period.',
          href: '/accounting',
        });
      }
    }

    // Measured against trading rather than the calendar: a shop shut for a
    // fortnight has nothing new to lose, and a warning that fires anyway is one
    // people learn to click past. See `getBackupStatus`.
    const backup = getBackupStatus(db);
    if (backup.state !== 'current') {
      notices.push({
        id: backup.state === 'never' ? 'never-backed-up' : 'stale-backup',
        tone: backup.state === 'due' ? 'warning' : 'danger',
        title:
          backup.state === 'never'
            ? 'No backup has ever been taken'
            : backup.entriesSince > 0
              ? `${backup.entriesSince} entr${backup.entriesSince === 1 ? 'y' : 'ies'} not yet backed up`
              : `Last backup was ${backup.daysSince} days ago`,
        detail: describeBackupStatus(backup),
        href: '/settings/health',
      });
    }
  }

  return notices;
}
