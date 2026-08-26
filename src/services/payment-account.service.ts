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

export interface PaymentAccountOption {
  id: number;
  name: string;
  kind: string;
  isActive: boolean;
}

/**
 * Just enough to fill a dropdown.
 *
 * `listPaymentAccounts` computes a live balance for every account, which is one
 * ledger query each. That is right for the Accounts page, which shows the
 * balances, and wasteful on the eight filter bars that only need names — those
 * were paying for a full balance sweep on every page load to render a `<select>`
 * nobody had opened.
 */
export function listPaymentAccountOptions(
  db: Db,
  includeInactive = false,
): PaymentAccountOption[] {
  const base = db
    .select({
      id: paymentAccounts.id,
      name: paymentAccounts.name,
      kind: paymentAccounts.kind,
      isActive: paymentAccounts.isActive,
    })
    .from(paymentAccounts);

  return (includeInactive ? base : base.where(eq(paymentAccounts.isActive, true)))
    .orderBy(asc(paymentAccounts.sortOrder))
    .all();
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

export interface AccountMovementQuery {
  from?: string;
  to?: string;
  /** SALE, EXPENSE, CUSTOMER_PAYMENT and so on — what caused the movement. */
  sourceType?: string;
  /** 'in' for money received, 'out' for money paid. */
  flow?: 'in' | 'out';
  /** Entry number, memo or line description. */
  search?: string;
  minAmount?: Minor;
  maxAmount?: Minor;
  limit?: number;
  offset?: number;
}

export interface AccountStatement {
  /**
   * What the account held before the first day of the window.
   *
   * Read from the ledger — every entry dated earlier — and NOT worked backwards
   * from today's balance. Those two agree only when the window ends today; ask
   * for last month and a subtraction from the current balance would hand the
   * shop a figure that has this month's trading baked into it.
   */
  opening: Minor;
  moneyIn: Minor;
  moneyOut: Minor;
  /** opening + in − out. What the account held at the end of the window. */
  closing: Minor;
  /** Movements in the window, newest first, page-limited. */
  movements: AccountMovement[];
  /** Movements in the whole window, for the pager. */
  total: number;
}

function movementConditions(glAccountId: number, query: AccountMovementQuery): SQL[] {
  const conditions: SQL[] = [eq(journalLines.accountId, glAccountId)];

  if (query.from) conditions.push(gte(journalEntries.entryDate, query.from));
  if (query.to) conditions.push(lte(journalEntries.entryDate, query.to));
  if (query.sourceType) {
    conditions.push(sql`${journalEntries.sourceType} = ${query.sourceType}`);
  }
  if (query.flow === 'in') conditions.push(sql`${journalLines.debitMinor} > 0`);
  if (query.flow === 'out') conditions.push(sql`${journalLines.creditMinor} > 0`);

  if (query.minAmount !== undefined) {
    conditions.push(
      sql`(${journalLines.debitMinor} + ${journalLines.creditMinor}) >= ${query.minAmount}`,
    );
  }
  if (query.maxAmount !== undefined) {
    conditions.push(
      sql`(${journalLines.debitMinor} + ${journalLines.creditMinor}) <= ${query.maxAmount}`,
    );
  }

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    conditions.push(
      sql`(
        lower(${journalEntries.entryNo}) LIKE ${term}
        OR lower(COALESCE(${journalEntries.memo}, '')) LIKE ${term}
        OR lower(COALESCE(${journalLines.description}, '')) LIKE ${term}
      )`,
    );
  }

  return conditions;
}

/**
 * A statement for one account: opening balance, the movements, closing balance.
 *
 * This is what answers "show me everything that touched my MTN MoMo account
 * this month" — and answers it in a form that adds up, which is the whole
 * point. Opening plus money in less money out equals closing, and the running
 * balance on the last row equals the closing figure, whatever window is asked
 * for.
 *
 * The running balance is a SQL window function rather than a loop in
 * JavaScript. That is not a micro-optimisation: the window is computed over
 * every row the filter selects, BEFORE the page limit is applied, so page two
 * of a statement carries on from where page one stopped instead of restarting
 * at zero.
 */
export function getAccountStatement(
  db: Db,
  id: number,
  query: AccountMovementQuery = {},
): AccountStatement {
  const account = db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
  if (!account) throw new NotFoundError('Payment account', id);

  // --- opening -------------------------------------------------------------
  // Deliberately ignores every filter except the account and the start date: an
  // opening balance is what the account HELD, not a subtotal of the rows that
  // happen to match a search box.
  const openingConditions: SQL[] = [eq(journalLines.accountId, account.glAccountId)];
  if (query.from) {
    openingConditions.push(sql`${journalEntries.entryDate} < ${query.from}`);
  } else {
    // No start date means the window opens at the beginning of the records, and
    // an account holds nothing before its first entry.
    openingConditions.push(sql`1 = 0`);
  }

  const openingRow = db
    .select({
      net: sql<number>`COALESCE(SUM(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...openingConditions))
    .get();

  const opening = minor(openingRow?.net ?? 0);

  // --- the window ----------------------------------------------------------
  const conditions = movementConditions(account.glAccountId, query);

  const totals = db
    .select({
      count: sql<number>`COUNT(*)`,
      moneyIn: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      moneyOut: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .get();

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
      /*
        SQLite computes window functions after WHERE and before ORDER BY and
        LIMIT, so this accumulates across the whole filtered window even though
        only one page of rows comes back.
      */
      runningBalance: sql<number>`(${opening} + SUM(${journalLines.debitMinor} - ${journalLines.creditMinor})
        OVER (ORDER BY ${journalEntries.occurredAt} ASC, ${journalEntries.id} ASC, ${journalLines.id} ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .orderBy(
      sql`${journalEntries.occurredAt} DESC`,
      sql`${journalEntries.id} DESC`,
      sql`${journalLines.id} DESC`,
    )
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0)
    .all();

  const moneyIn = minor(totals?.moneyIn ?? 0);
  const moneyOut = minor(totals?.moneyOut ?? 0);

  return {
    opening,
    moneyIn,
    moneyOut,
    closing: minor(opening + moneyIn - moneyOut),
    total: totals?.count ?? 0,
    movements: rows.map((row) => ({
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
      runningBalance: row.runningBalance,
    })),
  };
}

/**
 * Every movement through one account, newest first.
 *
 * Kept as the narrow read for callers that only want the rows. New code should
 * ask for `getAccountStatement`, which also says what the account opened and
 * closed at — a list of movements without those two figures cannot be checked.
 */
export function getAccountMovements(
  db: Db,
  id: number,
  query: AccountMovementQuery = {},
): AccountMovement[] {
  return getAccountStatement(db, id, query).movements;
}

/**
 * How many movements match, ignoring the page.
 *
 * Separate from `getAccountStatement` so a page can clamp its page number
 * before asking for rows, rather than fetching one page to learn the total and
 * then fetching another.
 */
export function countAccountMovements(
  db: Db,
  id: number,
  query: AccountMovementQuery = {},
): number {
  const account = db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
  if (!account) throw new NotFoundError('Payment account', id);

  const row = db
    .select({ total: sql<number>`COUNT(*)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...movementConditions(account.glAccountId, query)))
    .get();

  return row?.total ?? 0;
}

/** The transaction kinds an account has actually seen, for the filter list. */
export function listAccountSourceTypes(db: Db, id: number): string[] {
  const account = db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
  if (!account) throw new NotFoundError('Payment account', id);

  return db
    .selectDistinct({ sourceType: journalEntries.sourceType })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalLines.accountId, account.glAccountId))
    .orderBy(asc(journalEntries.sourceType))
    .all()
    .map((row) => row.sourceType);
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
