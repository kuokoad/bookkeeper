import { and, desc, eq, sql } from 'drizzle-orm';

import { auditLogs, businessSettings } from '@/db/schema';
import type { Db } from '@/db/types';
import { can, type Principal } from '@/lib/auth/permissions';
import { toBusinessDate } from '@/lib/format';
import { financialYearFor } from '@/domain/financial-year';
import { getStockSummary } from '@/services/catalog.service';
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

/** Backups are not tracked in a table; the audit log records each download. */
function daysSinceLastBackup(db: Db): number | null {
  const last = db
    .select({ at: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'backup'), eq(auditLogs.action, 'CREATE')))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1)
    .get();

  if (!last?.at) return null;
  return Math.floor((Date.now() - last.at.getTime()) / 86_400_000);
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

    const sinceBackup = daysSinceLastBackup(db);
    if (sinceBackup === null) {
      notices.push({
        id: 'never-backed-up',
        tone: 'warning',
        title: 'No backup has ever been taken',
        detail: 'Everything is in one file on this computer.',
        href: '/settings/health',
      });
    } else if (sinceBackup >= 7) {
      notices.push({
        id: 'stale-backup',
        tone: 'warning',
        title: `Last backup was ${sinceBackup} days ago`,
        detail: 'Take one and keep it off this computer.',
        href: '/settings/health',
      });
    }
  }

  return notices;
}
