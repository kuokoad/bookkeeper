import { eq, sql } from 'drizzle-orm';

import type { Tx } from '@/db/types';
import { accounts, businessSettings, paymentAccounts, sequences } from '@/db/schema';
import {
  ACCOUNT_CODES,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  DEFAULT_PAYMENT_ACCOUNTS,
  SYSTEM_ACCOUNTS,
} from '@/domain/accounting/chart-of-accounts';
import { DEFAULT_SEQUENCES } from '@/services/sequence.service';
import { writeAudit } from '@/services/audit.service';

/**
 * Baseline data every shop needs before it can record anything: settings, the
 * chart of accounts, document numbering and the default payment accounts.
 *
 * This is NOT demo data. It is idempotent — running it twice changes nothing —
 * so it can safely run after every migration.
 */

export function accountIdsByCode(tx: Tx): Map<string, number> {
  const rows = tx.select({ id: accounts.id, code: accounts.code }).from(accounts).all();
  return new Map(rows.map((row) => [row.code, row.id]));
}

function upsertAccount(
  tx: Tx,
  definition: {
    code: string;
    name: string;
    type: (typeof SYSTEM_ACCOUNTS)[number]['type'];
    normalBalance: (typeof SYSTEM_ACCOUNTS)[number]['normalBalance'];
    description: string;
    sortOrder: number;
    parentId?: number | null;
  },
  now: Date,
): number {
  const existing = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.code, definition.code))
    .get();

  if (existing) return existing.id;

  const inserted = tx
    .insert(accounts)
    .values({
      code: definition.code,
      name: definition.name,
      type: definition.type,
      normalBalance: definition.normalBalance,
      description: definition.description,
      sortOrder: definition.sortOrder,
      parentId: definition.parentId ?? null,
      isSystem: true,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: accounts.id })
    .get();

  if (!inserted) {
    throw new Error(`Failed to create system account ${definition.code}`);
  }
  return inserted.id;
}

export function seedBusinessSettings(tx: Tx, now: Date): void {
  const existing = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  if (existing) return;

  tx.insert(businessSettings)
    .values({ id: 1, createdAt: now, updatedAt: now })
    .run();
}

export function seedSequences(tx: Tx, now: Date): void {
  for (const definition of DEFAULT_SEQUENCES) {
    const existing = tx
      .select({ docType: sequences.docType })
      .from(sequences)
      .where(eq(sequences.docType, definition.docType))
      .get();
    if (existing) continue;

    tx.insert(sequences)
      .values({
        docType: definition.docType,
        prefix: definition.prefix,
        padding: definition.padding,
        nextNumber: 1,
        updatedAt: now,
      })
      .run();
  }
}

export function seedChartOfAccounts(tx: Tx, now: Date): void {
  // Headings and top-level accounts first, so children can reference them.
  for (const definition of SYSTEM_ACCOUNTS) {
    upsertAccount(tx, definition, now);
  }

  const byCode = accountIdsByCode(tx);
  const operatingExpensesId = byCode.get(ACCOUNT_CODES.OPERATING_EXPENSES);
  const otherIncomeId = byCode.get(ACCOUNT_CODES.OTHER_INCOME);

  if (operatingExpensesId === undefined || otherIncomeId === undefined) {
    throw new Error('Parent accounts missing — chart of accounts seed is inconsistent.');
  }

  DEFAULT_EXPENSE_CATEGORIES.forEach((category, index) => {
    upsertAccount(
      tx,
      {
        code: category.code,
        name: category.name,
        type: 'EXPENSE',
        normalBalance: 'DEBIT',
        description: `Operating expense: ${category.name}.`,
        sortOrder: 610 + index,
        parentId: operatingExpensesId,
      },
      now,
    );
  });

  DEFAULT_INCOME_CATEGORIES.forEach((category, index) => {
    upsertAccount(
      tx,
      {
        code: category.code,
        name: category.name,
        type: 'REVENUE',
        normalBalance: 'CREDIT',
        description: `Other income: ${category.name}.`,
        sortOrder: 430 + index,
        parentId: otherIncomeId,
      },
      now,
    );
  });
}

export function seedPaymentAccounts(tx: Tx, now: Date): void {
  const byCode = accountIdsByCode(tx);

  for (const definition of DEFAULT_PAYMENT_ACCOUNTS) {
    const existing = tx
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(sql`lower(${paymentAccounts.name}) = lower(${definition.name})`)
      .get();
    if (existing) continue;

    const parentId = byCode.get(definition.parentCode);
    if (parentId === undefined) {
      throw new Error(`Missing parent account ${definition.parentCode} for ${definition.name}`);
    }

    const glAccountId = upsertAccount(
      tx,
      {
        code: definition.glCode,
        name: definition.glName,
        type: 'ASSET',
        normalBalance: 'DEBIT',
        description: `Ledger account backing the "${definition.name}" payment account.`,
        sortOrder: definition.sortOrder,
        parentId,
      },
      now,
    );

    tx.insert(paymentAccounts)
      .values({
        name: definition.name,
        kind: definition.kind,
        provider: definition.provider,
        glAccountId,
        isActive: true,
        isDefault: definition.isDefault,
        sortOrder: definition.sortOrder,
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

/** Run the whole baseline. Idempotent. */
export function seedCore(tx: Tx, now: Date = new Date()): void {
  seedBusinessSettings(tx, now);
  seedSequences(tx, now);
  seedChartOfAccounts(tx, now);
  seedPaymentAccounts(tx, now);

  writeAudit(tx, {
    action: 'CREATE',
    entityType: 'system',
    entityId: 'core-seed',
    summary: 'Baseline chart of accounts, sequences and payment accounts verified',
    at: now,
  });
}
