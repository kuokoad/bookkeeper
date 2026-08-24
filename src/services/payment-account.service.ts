import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import { accounts, journalEntries, journalLines, paymentAccounts } from '@/db/schema';
import type { AccountType, PaymentAccountKind } from '@/db/schema/accounting';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor, subtract, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * Payment accounts — the pots of money the owner actually thinks in:
 * "Cash box", "MTN MoMo", "Telecel Cash", "GCB current account".
 *
 * Each owns exactly one ledger account, so its balance is a plain query over
 * journal lines and can never disagree with the books. `provider` is free text
 * by design: adding a new mobile money network is data entry, not a code change.
 */

/** Which heading a new account of each kind is filed under. */
const PARENT_BY_KIND: Record<PaymentAccountKind, string> = {
  CASH: ACCOUNT_CODES.CASH,
  MOBILE_MONEY: ACCOUNT_CODES.MOBILE_MONEY,
  BANK: ACCOUNT_CODES.BANK,
  OTHER: ACCOUNT_CODES.CASH,
};

export interface PaymentAccountInput {
  name: string;
  kind: PaymentAccountKind;
  provider?: string | undefined;
  accountNumber?: string | undefined;
  isDefault?: boolean;
}

/**
 * Next free code under a heading, e.g. 1011 -> 1012.
 * Keeps the chart of accounts tidy without the owner ever seeing a code.
 */
function nextChildCode(tx: Tx, parentCode: string): string {
  const parent = tx.select().from(accounts).where(eq(accounts.code, parentCode)).get();
  if (!parent) throw new NotFoundError('Account', parentCode);

  const children = tx
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.parentId, parent.id))
    .all();

  const base = Number(parentCode);
  let candidate = base + 1;
  const used = new Set(children.map((child) => Number(child.code)));
  while (used.has(candidate)) candidate += 1;

  // Stay inside the heading's block (e.g. 1010-1019 for mobile money).
  if (candidate >= base + 10) {
    throw new ConflictError(
      'There is no room for another account under this heading. Archive one you no longer use.',
    );
  }
  return String(candidate);
}

export function createPaymentAccount(db: Db, input: PaymentAccountInput, actor: Actor): number {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter a name for the account.');

  return writeTransaction(db, (tx) => {
    const clash = tx
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(sql`lower(${paymentAccounts.name}) = lower(${name})`)
      .get();
    if (clash) throw new ConflictError(`An account called "${name}" already exists.`);

    const parentCode = PARENT_BY_KIND[input.kind];
    const parent = tx.select().from(accounts).where(eq(accounts.code, parentCode)).get();
    if (!parent) throw new NotFoundError('Account', parentCode);

    const now = new Date();
    const code = nextChildCode(tx, parentCode);

    const glAccount = tx
      .insert(accounts)
      .values({
        code,
        name,
        type: 'ASSET' as AccountType,
        normalBalance: 'DEBIT',
        parentId: parent.id,
        description: `Ledger account backing the "${name}" payment account.`,
        isSystem: true,
        isActive: true,
        sortOrder: Number(code),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: accounts.id })
      .get();

    if (!glAccount) throw new ConflictError('Could not create the ledger account.');

    // At most one default; setting a new one clears the old.
    if (input.isDefault) {
      tx.update(paymentAccounts).set({ isDefault: false, updatedAt: now }).run();
    }

    const maxOrder = tx
      .select({ value: sql<number>`COALESCE(MAX(${paymentAccounts.sortOrder}), 0)` })
      .from(paymentAccounts)
      .get();

    const inserted = tx
      .insert(paymentAccounts)
      .values({
        name,
        kind: input.kind,
        provider: input.provider?.trim() || null,
        accountNumber: input.accountNumber?.trim() || null,
        glAccountId: glAccount.id,
        isActive: true,
        isDefault: input.isDefault ?? false,
        sortOrder: (maxOrder?.value ?? 0) + 10,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: paymentAccounts.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the payment account.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'payment_account',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Added payment account "${name}" (${input.kind.toLowerCase().replace('_', ' ')})`,
      metadata: { kind: input.kind, provider: input.provider, glCode: code },
      at: now,
    });

    return inserted.id;
  });
}

export function updatePaymentAccount(
  db: Db,
  id: number,
  input: PaymentAccountInput,
  actor: Actor,
): void {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter a name for the account.');

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
    if (!existing) throw new NotFoundError('Payment account', id);

    const clash = tx
      .select({ id: paymentAccounts.id })
      .from(paymentAccounts)
      .where(sql`lower(${paymentAccounts.name}) = lower(${name}) AND ${paymentAccounts.id} <> ${id}`)
      .get();
    if (clash) throw new ConflictError(`An account called "${name}" already exists.`);

    const now = new Date();

    if (input.isDefault) {
      tx.update(paymentAccounts).set({ isDefault: false, updatedAt: now }).run();
    }

    tx.update(paymentAccounts)
      .set({
        name,
        provider: input.provider?.trim() || null,
        accountNumber: input.accountNumber?.trim() || null,
        isDefault: input.isDefault ?? existing.isDefault,
        updatedAt: now,
      })
      .where(eq(paymentAccounts.id, id))
      .run();

    // Keep the ledger account's name in step so reports read sensibly.
    tx.update(accounts)
      .set({ name, updatedAt: now })
      .where(eq(accounts.id, existing.glAccountId))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'payment_account',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Updated payment account "${name}"`,
      metadata: { before: { name: existing.name }, after: { name } },
      at: now,
    });
  });
}

/**
 * Accounts are archived, never deleted — their history must survive. Archiving
 * is refused while money is still in one, because a hidden balance is how cash
 * goes missing from a set of books.
 */
export function setPaymentAccountActive(
  db: Db,
  id: number,
  isActive: boolean,
  actor: Actor,
): void {
  writeTransaction(db, (tx) => {
    const existing = tx.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
    if (!existing) throw new NotFoundError('Payment account', id);

    if (!isActive) {
      const balance = getPaymentAccountBalance(tx, id);
      if (balance !== 0) {
        throw new ConflictError(
          `"${existing.name}" still holds money. Move the balance out before archiving it.`,
        );
      }
      if (existing.isDefault) {
        throw new ConflictError('Make another account the default before archiving this one.');
      }
    }

    const now = new Date();
    tx.update(paymentAccounts)
      .set({ isActive, updatedAt: now })
      .where(eq(paymentAccounts.id, id))
      .run();
    tx.update(accounts)
      .set({ isActive, updatedAt: now })
      .where(eq(accounts.id, existing.glAccountId))
      .run();

    writeAudit(tx, {
      action: isActive ? 'RESTORE' : 'ARCHIVE',
      entityType: 'payment_account',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${isActive ? 'Restored' : 'Archived'} payment account "${existing.name}"`,
      at: now,
    });
  });
}

// --- reads ----------------------------------------------------------------

/** Balance of one payment account, derived from its ledger lines. */
export function getPaymentAccountBalance(db: Db, id: number, upTo?: string): Minor {
  const account = db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
  if (!account) throw new NotFoundError('Payment account', id);

  const conditions: SQL[] = [eq(journalLines.accountId, account.glAccountId)];
  if (upTo) conditions.push(lte(journalEntries.entryDate, upTo));

  const row = db
    .select({
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .get();

  // Asset account: debits increase, credits decrease.
  return subtract(minor(row?.debit ?? 0), minor(row?.credit ?? 0));
}

export interface PaymentAccountSummary {
  id: number;
  name: string;
  kind: string;
  provider: string | null;
  accountNumber: string | null;
  glCode: string;
  glAccountId: number;
  balance: Minor;
  isActive: boolean;
  isDefault: boolean;
}

export function listPaymentAccounts(db: Db, includeInactive = false): PaymentAccountSummary[] {
  const rows = db
    .select({
      id: paymentAccounts.id,
      name: paymentAccounts.name,
      kind: paymentAccounts.kind,
      provider: paymentAccounts.provider,
      accountNumber: paymentAccounts.accountNumber,
      glAccountId: paymentAccounts.glAccountId,
      glCode: accounts.code,
      isActive: paymentAccounts.isActive,
      isDefault: paymentAccounts.isDefault,
      sortOrder: paymentAccounts.sortOrder,
    })
    .from(paymentAccounts)
    .innerJoin(accounts, eq(accounts.id, paymentAccounts.glAccountId))
    .orderBy(asc(paymentAccounts.sortOrder))
    .all();

  return rows
    .filter((row) => includeInactive || row.isActive)
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      provider: row.provider,
      accountNumber: row.accountNumber,
      glCode: row.glCode,
      glAccountId: row.glAccountId,
      balance: getPaymentAccountBalance(db, row.id),
      isActive: row.isActive,
      isDefault: row.isDefault,
    }));
}

export function getPaymentAccount(db: Db, id: number): PaymentAccountSummary {
  const found = listPaymentAccounts(db, true).find((account) => account.id === id);
  if (!found) throw new NotFoundError('Payment account', id);
  return found;
}

export interface AccountMovement {
  entryId: number;
  entryNo: string;
  entryDate: string;
  occurredAt: Date;
  sourceType: string;
  sourceId: number | null;
  memo: string | null;
  description: string | null;
  inMinor: number;
  outMinor: number;
  runningBalance: number;
}

/**
 * Every movement through one account, with a running balance.
 *
 * This is what answers "why is cash GHS 5,240?" — the figure on the dashboard
 * and the lines that produced it, side by side.
 */
export function getAccountMovements(
  db: Db,
  id: number,
  query: { from?: string; to?: string; limit?: number } = {},
): AccountMovement[] {
  const account = db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
  if (!account) throw new NotFoundError('Payment account', id);

  const conditions: SQL[] = [eq(journalLines.accountId, account.glAccountId)];
  if (query.from) conditions.push(gte(journalEntries.entryDate, query.from));
  if (query.to) conditions.push(lte(journalEntries.entryDate, query.to));

  const rows = db
    .select({
      entryId: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      occurredAt: journalEntries.occurredAt,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      memo: journalEntries.memo,
      description: journalLines.description,
      debit: journalLines.debitMinor,
      credit: journalLines.creditMinor,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.occurredAt), asc(journalEntries.id))
    .all();

  // Running balance is computed oldest-first, then presented newest-first.
  let running = 0;
  const withBalance = rows.map((row) => {
    running += row.debit - row.credit;
    return {
      entryId: row.entryId,
      entryNo: row.entryNo,
      entryDate: row.entryDate,
      occurredAt: row.occurredAt,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      memo: row.memo,
      description: row.description,
      inMinor: row.debit,
      outMinor: row.credit,
      runningBalance: running,
    };
  });

  return withBalance.reverse().slice(0, Math.min(query.limit ?? 200, 500));
}

// --- categories (which are accounts) --------------------------------------

export interface CategoryOption {
  id: number;
  code: string;
  name: string;
}

/** Leaf accounts under a heading — what the owner picks as a "category". */
function leafChildren(db: Db, parentCode: string): CategoryOption[] {
  const parent = db.select().from(accounts).where(eq(accounts.code, parentCode)).get();
  if (!parent) return [];

  return db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.parentId, parent.id), eq(accounts.isActive, true)))
    .orderBy(asc(accounts.sortOrder), asc(accounts.name))
    .all();
}

export function listExpenseCategories(db: Db): CategoryOption[] {
  return leafChildren(db, ACCOUNT_CODES.OPERATING_EXPENSES);
}

export function listIncomeCategories(db: Db): CategoryOption[] {
  return leafChildren(db, ACCOUNT_CODES.OTHER_INCOME);
}

/**
 * Add a category. Because a category IS an account, this creates a child of the
 * relevant heading with the next free code — the owner never sees a code.
 */
export function createCategory(
  db: Db,
  kind: 'EXPENSE' | 'INCOME',
  name: string,
  actor: Actor,
): number {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new ValidationError('Enter a category name.');

  return writeTransaction(db, (tx) => {
    const parentCode =
      kind === 'EXPENSE' ? ACCOUNT_CODES.OPERATING_EXPENSES : ACCOUNT_CODES.OTHER_INCOME;
    const parent = tx.select().from(accounts).where(eq(accounts.code, parentCode)).get();
    if (!parent) throw new NotFoundError('Account', parentCode);

    const clash = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.parentId, parent.id), sql`lower(${accounts.name}) = lower(${trimmed})`),
      )
      .get();
    if (clash) throw new ConflictError(`A category called "${trimmed}" already exists.`);

    const siblings = tx
      .select({ code: accounts.code })
      .from(accounts)
      .where(eq(accounts.parentId, parent.id))
      .all();

    // Expense categories live in 6001-6899, income in 4201-4299.
    const base = Number(parentCode);
    const used = new Set(siblings.map((sibling) => Number(sibling.code)));
    let candidate = base + 10;
    while (used.has(candidate)) candidate += 10;
    if (candidate >= base + (kind === 'EXPENSE' ? 900 : 100)) {
      throw new ConflictError('There is no room for another category.');
    }

    const now = new Date();
    const inserted = tx
      .insert(accounts)
      .values({
        code: String(candidate),
        name: trimmed,
        type: kind === 'EXPENSE' ? 'EXPENSE' : 'REVENUE',
        normalBalance: kind === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
        parentId: parent.id,
        description: kind === 'EXPENSE' ? `Operating expense: ${trimmed}.` : `Other income: ${trimmed}.`,
        isSystem: false,
        isActive: true,
        sortOrder: candidate,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: accounts.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the category.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'category',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Added ${kind.toLowerCase()} category "${trimmed}"`,
      at: now,
    });

    return inserted.id;
  });
}
