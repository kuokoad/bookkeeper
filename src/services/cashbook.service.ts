import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import { accounts, expenses, incomes, ownerMovements, paymentAccounts } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit } from '@/domain/accounting/journal';
import { minor, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';

/**
 * Expenses and other income.
 *
 * These are mirror images of each other:
 *
 *   Expense:  Dr Expense category   Cr Cash / MoMo / Bank
 *   Income:   Dr Cash / MoMo / Bank Cr Income category
 *
 * so the posting logic lives here exactly once, parameterised by direction,
 * rather than being written twice and drifting apart.
 */

type Direction = 'EXPENSE' | 'INCOME';

export interface CashbookInput {
  businessDate: string;
  categoryAccountId: number;
  description: string;
  amount: Minor;
  paymentAccountId: number;
  reference?: string | undefined;
  note?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
}

export interface CashbookResult {
  id: number;
  documentNo: string;
  journalEntryId: number;
}

/**
 * The category must be an account of the right TYPE, and must be a leaf.
 * Posting an expense to a revenue account, or to a heading that groups other
 * accounts, would quietly corrupt the Profit & Loss.
 */
function assertCategoryUsable(tx: Tx, accountId: number, direction: Direction): string {
  const account = tx.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new NotFoundError('Account', accountId);

  const expectedTypes = direction === 'EXPENSE' ? ['EXPENSE', 'COGS'] : ['REVENUE'];
  if (!expectedTypes.includes(account.type)) {
    throw new ValidationError(
      `"${account.name}" is not a valid ${direction === 'EXPENSE' ? 'expense' : 'income'} category.`,
      { accountId, type: account.type },
    );
  }
  if (!account.isActive) {
    throw new ValidationError(`The category "${account.name}" is no longer in use.`);
  }

  const childCount = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.parentId, accountId))
    .all().length;
  if (childCount > 0) {
    throw new ValidationError(
      `"${account.name}" is a heading. Choose one of the categories under it.`,
    );
  }

  return account.name;
}

function record(
  db: Db,
  direction: Direction,
  input: CashbookInput,
  actor: Actor,
): CashbookResult {
  if (input.amount <= 0) {
    throw new ValidationError('Enter an amount greater than zero.');
  }
  if (input.description.trim().length === 0) {
    throw new ValidationError('Enter a short description.');
  }

  return db.transaction((tx) => {
    const occurredAt = input.occurredAt ?? new Date();
    const categoryName = assertCategoryUsable(tx, input.categoryAccountId, direction);

    const paymentAccount = tx
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, input.paymentAccountId))
      .get();
    if (!paymentAccount) throw new NotFoundError('Payment account', input.paymentAccountId);
    if (!paymentAccount.isActive) {
      throw new ValidationError(`Payment account "${paymentAccount.name}" is not active.`);
    }

    const isExpense = direction === 'EXPENSE';
    const documentNo = nextDocumentNumber(tx, isExpense ? DOC_TYPES.EXPENSE : DOC_TYPES.INCOME);
    const description = input.description.trim();

    const inserted = isExpense
      ? tx
          .insert(expenses)
          .values({
            expenseNo: documentNo,
            businessDate: input.businessDate,
            occurredAt,
            categoryAccountId: input.categoryAccountId,
            description,
            amountMinor: input.amount,
            paymentAccountId: input.paymentAccountId,
            reference: input.reference ?? null,
            note: input.note ?? null,
            status: 'POSTED',
            createdBy: actor.id,
            isDemo: input.isDemo ?? false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning({ id: expenses.id })
          .get()
      : tx
          .insert(incomes)
          .values({
            incomeNo: documentNo,
            businessDate: input.businessDate,
            occurredAt,
            categoryAccountId: input.categoryAccountId,
            description,
            amountMinor: input.amount,
            paymentAccountId: input.paymentAccountId,
            reference: input.reference ?? null,
            note: input.note ?? null,
            status: 'POSTED',
            createdBy: actor.id,
            isDemo: input.isDemo ?? false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .returning({ id: incomes.id })
          .get();

    if (!inserted) throw new ConflictError('Could not save the record.');

    const lines = isExpense
      ? [
          debit(input.categoryAccountId, input.amount, {
            description: `${documentNo} ${categoryName}`,
          }),
          credit(paymentAccount.glAccountId, input.amount, {
            paymentAccountId: input.paymentAccountId,
            description: `${documentNo} paid from ${paymentAccount.name}`,
          }),
        ]
      : [
          debit(paymentAccount.glAccountId, input.amount, {
            paymentAccountId: input.paymentAccountId,
            description: `${documentNo} received into ${paymentAccount.name}`,
          }),
          credit(input.categoryAccountId, input.amount, {
            description: `${documentNo} ${categoryName}`,
          }),
        ];

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: isExpense ? 'EXPENSE' : 'INCOME',
        sourceId: inserted.id,
        memo: `${documentNo} — ${description}`,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    if (isExpense) {
      tx.update(expenses)
        .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
        .where(eq(expenses.id, inserted.id))
        .run();
    } else {
      tx.update(incomes)
        .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
        .where(eq(incomes.id, inserted.id))
        .run();
    }

    writeAudit(tx, {
      action: 'CREATE',
      entityType: isExpense ? 'expense' : 'income',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `${documentNo}: ${categoryName} — ${description}`,
      metadata: {
        amountMinor: input.amount,
        paymentAccount: paymentAccount.name,
        entryNo: posted.entryNo,
      },
      at: occurredAt,
    });

    return { id: inserted.id, documentNo, journalEntryId: posted.entryId };
  });
}

export function recordExpense(db: Db, input: CashbookInput, actor: Actor): CashbookResult {
  return record(db, 'EXPENSE', input, actor);
}

export function recordIncome(db: Db, input: CashbookInput, actor: Actor): CashbookResult {
  return record(db, 'INCOME', input, actor);
}

/** Void either kind by posting a reversing entry. The original row is kept. */
function voidRecord(
  db: Db,
  direction: Direction,
  id: number,
  reason: string,
  actor: Actor,
  now: Date,
): void {
  if (reason.trim().length < 3) {
    throw new ValidationError('Give a reason for voiding this record.');
  }

  db.transaction((tx) => {
    const isExpense = direction === 'EXPENSE';
    const row = isExpense
      ? tx.select().from(expenses).where(eq(expenses.id, id)).get()
      : tx.select().from(incomes).where(eq(incomes.id, id)).get();

    if (!row) throw new NotFoundError(isExpense ? 'Expense' : 'Income', id);
    if (row.status === 'VOIDED') throw new ConflictError('That record has already been voided.');

    const documentNo = isExpense
      ? (row as { expenseNo: string }).expenseNo
      : (row as { incomeNo: string }).incomeNo;

    if (row.journalEntryId !== null) {
      reverseJournalEntry(
        tx,
        row.journalEntryId,
        {
          entryDate: toBusinessDateString(now),
          sourceType: isExpense ? 'EXPENSE' : 'INCOME',
          sourceId: id,
          memo: `Void of ${documentNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
    }

    const patch = { status: 'VOIDED' as const, voidedAt: now, voidReason: reason.trim(), updatedAt: now };
    if (isExpense) {
      tx.update(expenses).set(patch).where(eq(expenses.id, id)).run();
    } else {
      tx.update(incomes).set(patch).where(eq(incomes.id, id)).run();
    }

    writeAudit(tx, {
      action: 'VOID',
      entityType: isExpense ? 'expense' : 'income',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Voided ${documentNo}`,
      metadata: { reason: reason.trim() },
      at: now,
    });
  });
}

export function voidExpense(
  db: Db,
  id: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): void {
  voidRecord(db, 'EXPENSE', id, reason, actor, now);
}

export function voidIncome(
  db: Db,
  id: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): void {
  voidRecord(db, 'INCOME', id, reason, actor, now);
}

// --- owner capital and drawings -------------------------------------------

export interface OwnerMovementInput {
  businessDate: string;
  paymentAccountId: number;
  amount: Minor;
  description?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
}

/**
 * The owner putting money INTO the business, or taking it OUT.
 *
 *   Capital in:  Dr Cash / MoMo / Bank   Cr Owner's Capital
 *   Drawings:    Dr Owner's Drawings     Cr Cash / MoMo / Bank
 *
 * Drawings are deliberately NOT an expense — money the owner takes for personal
 * use reduces their stake in the business, it does not reduce its profit. Using
 * a contra-equity account keeps the Profit & Loss honest.
 */
function recordOwnerMovement(
  db: Db,
  direction: 'CAPITAL' | 'DRAWINGS',
  input: OwnerMovementInput,
  actor: Actor,
): CashbookResult {
  if (input.amount <= 0) {
    throw new ValidationError('Enter an amount greater than zero.');
  }

  return db.transaction((tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const paymentAccount = tx
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, input.paymentAccountId))
      .get();
    if (!paymentAccount) throw new NotFoundError('Payment account', input.paymentAccountId);

    const isCapital = direction === 'CAPITAL';
    const equityCode = isCapital ? ACCOUNT_CODES.OWNERS_CAPITAL : ACCOUNT_CODES.OWNERS_DRAWINGS;
    const equityAccount = tx.select().from(accounts).where(eq(accounts.code, equityCode)).get();
    if (!equityAccount) throw new NotFoundError('Account', equityCode);

    const description =
      input.description?.trim() ||
      (isCapital ? 'Owner put money into the business' : 'Owner took money out');

    const lines = isCapital
      ? [
          debit(paymentAccount.glAccountId, input.amount, {
            paymentAccountId: input.paymentAccountId,
            description,
          }),
          credit(equityAccount.id, input.amount, { description }),
        ]
      : [
          debit(equityAccount.id, input.amount, { description }),
          credit(paymentAccount.glAccountId, input.amount, {
            paymentAccountId: input.paymentAccountId,
            description,
          }),
        ];

    // A real source row, so the journal entry has something to point at.
    const movementNo = nextDocumentNumber(tx, isCapital ? DOC_TYPES.INCOME : DOC_TYPES.EXPENSE);
    const movement = tx
      .insert(ownerMovements)
      .values({
        movementNo,
        kind: direction,
        businessDate: input.businessDate,
        occurredAt,
        paymentAccountId: input.paymentAccountId,
        amountMinor: input.amount,
        description,
        status: 'POSTED',
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: ownerMovements.id })
      .get();

    if (!movement) throw new ConflictError('Could not record the owner movement.');

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: direction,
        sourceId: movement.id,
        memo: description,
        isOpening: isCapital,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(ownerMovements)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(ownerMovements.id, movement.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: isCapital ? 'owner_capital' : 'owner_drawings',
      entityId: movement.id,
      userId: actor.id,
      username: actor.username,
      summary: `${description} — ${paymentAccount.name}`,
      metadata: { amountMinor: input.amount, entryNo: posted.entryNo },
      at: occurredAt,
    });

    return { id: movement.id, documentNo: movementNo, journalEntryId: posted.entryId };
  });
}

export function recordOwnerCapital(
  db: Db,
  input: OwnerMovementInput,
  actor: Actor,
): CashbookResult {
  return recordOwnerMovement(db, 'CAPITAL', input, actor);
}

export function recordOwnerDrawings(
  db: Db,
  input: OwnerMovementInput,
  actor: Actor,
): CashbookResult {
  return recordOwnerMovement(db, 'DRAWINGS', input, actor);
}

function toBusinessDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- reads ----------------------------------------------------------------

export interface CashbookQuery {
  from?: string;
  to?: string;
  categoryAccountId?: number;
  limit?: number;
}

export function listExpenses(db: Db, query: CashbookQuery = {}) {
  const conditions: SQL[] = [];
  if (query.from) conditions.push(gte(expenses.businessDate, query.from));
  if (query.to) conditions.push(lte(expenses.businessDate, query.to));
  if (query.categoryAccountId !== undefined) {
    conditions.push(eq(expenses.categoryAccountId, query.categoryAccountId));
  }

  const base = db
    .select({
      id: expenses.id,
      documentNo: expenses.expenseNo,
      businessDate: expenses.businessDate,
      occurredAt: expenses.occurredAt,
      description: expenses.description,
      amountMinor: expenses.amountMinor,
      categoryName: accounts.name,
      categoryAccountId: expenses.categoryAccountId,
      paymentAccountName: paymentAccounts.name,
      reference: expenses.reference,
      status: expenses.status,
    })
    .from(expenses)
    .innerJoin(accounts, eq(accounts.id, expenses.categoryAccountId))
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, expenses.paymentAccountId));

  return (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(desc(expenses.businessDate), desc(expenses.id))
    .limit(Math.min(query.limit ?? 200, 500))
    .all();
}

export function listIncomes(db: Db, query: CashbookQuery = {}) {
  const conditions: SQL[] = [];
  if (query.from) conditions.push(gte(incomes.businessDate, query.from));
  if (query.to) conditions.push(lte(incomes.businessDate, query.to));
  if (query.categoryAccountId !== undefined) {
    conditions.push(eq(incomes.categoryAccountId, query.categoryAccountId));
  }

  const base = db
    .select({
      id: incomes.id,
      documentNo: incomes.incomeNo,
      businessDate: incomes.businessDate,
      occurredAt: incomes.occurredAt,
      description: incomes.description,
      amountMinor: incomes.amountMinor,
      categoryName: accounts.name,
      categoryAccountId: incomes.categoryAccountId,
      paymentAccountName: paymentAccounts.name,
      reference: incomes.reference,
      status: incomes.status,
    })
    .from(incomes)
    .innerJoin(accounts, eq(accounts.id, incomes.categoryAccountId))
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, incomes.paymentAccountId));

  return (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(desc(incomes.businessDate), desc(incomes.id))
    .limit(Math.min(query.limit ?? 200, 500))
    .all();
}

export function getExpensesTotal(db: Db, from: string, to: string): Minor {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${expenses.amountMinor}), 0)` })
    .from(expenses)
    .where(
      and(
        gte(expenses.businessDate, from),
        lte(expenses.businessDate, to),
        eq(expenses.status, 'POSTED'),
      ),
    )
    .get();
  return minor(row?.total ?? 0);
}

export function getIncomesTotal(db: Db, from: string, to: string): Minor {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${incomes.amountMinor}), 0)` })
    .from(incomes)
    .where(
      and(
        gte(incomes.businessDate, from),
        lte(incomes.businessDate, to),
        eq(incomes.status, 'POSTED'),
      ),
    )
    .get();
  return minor(row?.total ?? 0);
}

export interface ExpenseCategoryTotal {
  categoryAccountId: number;
  categoryName: string;
  total: Minor;
  count: number;
}

/**
 * Spending grouped by category for the period — what the expense report shows.
 *
 * The total is wrapped as `Minor` rather than handed back as the raw number the
 * driver returns. Every other reporting function returns branded money, and an
 * unbranded number is exactly what the brand exists to catch before it reaches
 * a formatter or an arithmetic operation.
 */
export function getExpensesByCategory(db: Db, from: string, to: string): ExpenseCategoryTotal[] {
  return db
    .select({
      categoryAccountId: expenses.categoryAccountId,
      categoryName: accounts.name,
      total: sql<number>`COALESCE(SUM(${expenses.amountMinor}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(expenses)
    .innerJoin(accounts, eq(accounts.id, expenses.categoryAccountId))
    .where(
      and(
        gte(expenses.businessDate, from),
        lte(expenses.businessDate, to),
        eq(expenses.status, 'POSTED'),
      ),
    )
    .groupBy(expenses.categoryAccountId)
    .orderBy(sql`SUM(${expenses.amountMinor}) DESC`)
    .all()
    .map((row) => ({ ...row, total: minor(row.total) }));
}
