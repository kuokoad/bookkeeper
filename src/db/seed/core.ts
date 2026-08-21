import { eq, sql } from 'drizzle-orm';

import type { Tx } from '@/db/types';
import { accounts, businessSettings, paymentAccounts, sequences, taxComponents } from '@/db/schema';
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

/**
 * The taxes a Ghanaian shop charges.
 *
 * Seeded at their statutory rates but switched OFF, because whether a shop
 * charges tax at all depends on whether it is VAT-registered — most small ones
 * are not, and a shop that starts adding 20% to every sale the day it installs
 * the software would be overcharging its customers. Switching tax on is a
 * deliberate act in Settings.
 *
 * Existing rows are never touched. A shop that has adjusted its own rates after
 * a budget must not have them silently reset by an upgrade.
 */
export function seedTaxComponents(tx: Tx, now: Date): void {
  const ids = accountIdsByCode(tx);

  const alreadySetUp = tx.select({ id: taxComponents.id }).from(taxComponents).get() !== undefined;
  if (alreadySetUp) return;

  /**
   * A shop that had ALREADY set a rate keeps that rate.
   *
   * Before this, tax was a single rate on the settings row. Seeding the Ghana
   * defaults over the top of a shop that had, say, 12.5% configured would take
   * it to 20% the moment it upgraded — every customer overcharged, with nobody
   * having asked for it and nothing on screen to say why. So an existing rate
   * is carried into VAT and the levies arrive switched off, for the owner to
   * turn on when they mean to.
   *
   * A configured rate counts whether or not tax is currently switched ON. A
   * shop that set 12.5% and then turned tax off still means 12.5% when it
   * turns tax back on, and its Settings screen still says so — taking it to
   * 20% behind that unchanged number is the same overcharge, only delayed.
   */
  const settings = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const existingRate = settings?.taxRateBp ?? 0;
  const preserving = existingRate > 0;

  const definitions = [
    {
      code: 'NHIL',
      name: 'NHIL',
      rateBp: 250,
      isRecoverable: false,
      accountCode: ACCOUNT_CODES.NHIL_PAYABLE,
      sortOrder: 10,
    },
    {
      code: 'GETFUND',
      name: 'GETFund',
      rateBp: 250,
      isRecoverable: false,
      accountCode: ACCOUNT_CODES.GETFUND_PAYABLE,
      sortOrder: 20,
    },
    {
      // Reclaimable, unlike the levies above — see the note on the column.
      code: 'VAT',
      name: 'VAT',
      rateBp: 1_500,
      isRecoverable: true,
      accountCode: ACCOUNT_CODES.TAX_PAYABLE,
      sortOrder: 30,
    },
  ];

  for (const definition of definitions) {
    const glAccountId = ids.get(definition.accountCode);
    if (glAccountId === undefined) {
      throw new Error(`Tax component ${definition.code} needs account ${definition.accountCode}`);
    }

    const isVat = definition.code === 'VAT';
    const rateBp = preserving && isVat ? existingRate : definition.rateBp;

    tx.insert(taxComponents)
      .values({
        code: definition.code,
        name: definition.name,
        rateBp,
        isRecoverable: definition.isRecoverable,
        glAccountId,
        sortOrder: definition.sortOrder,
        // Carrying an existing rate forward means only VAT starts switched on;
        // the levies wait for the owner to say so.
        isActive: preserving ? isVat : true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  if (preserving) {
    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'system',
      entityId: 'tax-components',
      summary: `Kept the existing tax rate on upgrade; NHIL and GETFund added but switched off`,
      metadata: { existingRateBp: existingRate },
      at: now,
    });
  }
}

/** Run the whole baseline. Idempotent. */
export function seedCore(tx: Tx, now: Date = new Date()): void {
  seedBusinessSettings(tx, now);
  seedSequences(tx, now);
  seedChartOfAccounts(tx, now);
  seedPaymentAccounts(tx, now);
  seedTaxComponents(tx, now);

  writeAudit(tx, {
    action: 'CREATE',
    entityType: 'system',
    entityId: 'core-seed',
    summary: 'Baseline chart of accounts, sequences and payment accounts verified',
    at: now,
  });
}
