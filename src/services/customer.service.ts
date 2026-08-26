import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import { accounts, customers, journalLines } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { creditHeadroom } from '@/domain/sales/calculate';
import { minor, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * Customers and what they owe.
 *
 * A customer's balance is NEVER stored. It is computed from the journal lines
 * on the Accounts Receivable control account tagged with their id, which means
 * the figure on their profile and the figure on the balance sheet are the same
 * number read two ways. The test suite asserts that the sum of all customer
 * balances equals the A/R control account exactly.
 */

export interface CustomerInput {
  name: string;
  phone?: string | undefined;
  email?: string | undefined;
  address?: string | undefined;
  notes?: string | undefined;
  /** null means no limit; 0 means no credit allowed at all. */
  creditLimit?: Minor | null;
}

/**
 * What this customer owes right now.
 *
 * Debits to A/R increase what they owe (a credit sale); credits reduce it (a
 * payment, or a reversal). A/R is a debit-normal account, so the balance is
 * debits minus credits.
 */
export function getCustomerBalance(tx: Tx | Db, customerId: number): Minor {
  const row = tx
    .select({
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalLines.customerId, customerId),
        eq(accounts.code, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
      ),
    )
    .get();

  return minor((row?.debit ?? 0) - (row?.credit ?? 0));
}

/** Every customer's balance in one query, for the list and the ageing report. */
export function getAllCustomerBalances(db: Db): Map<number, Minor> {
  const rows = db
    .select({
      customerId: journalLines.customerId,
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(accounts.code, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE))
    .groupBy(journalLines.customerId)
    .all();

  const balances = new Map<number, Minor>();
  for (const row of rows) {
    if (row.customerId === null) continue;
    balances.set(row.customerId, minor(row.debit - row.credit));
  }
  return balances;
}

/** Total owed to the shop by everyone — the accounts receivable figure. */
export function getTotalReceivables(db: Db): Minor {
  let total = 0;
  for (const balance of getAllCustomerBalances(db).values()) total += balance;
  return minor(total);
}

export function createCustomer(db: Db, input: CustomerInput, actor: Actor): number {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter the customer’s name.');
  if (input.creditLimit !== null && input.creditLimit !== undefined && input.creditLimit < 0) {
    throw new ValidationError('A credit limit cannot be negative.');
  }

  return writeTransaction(db, (tx) => {
    const now = new Date();
    const inserted = tx
      .insert(customers)
      .values({
        name,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
        creditLimitMinor: input.creditLimit ?? null,
        isActive: true,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: customers.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the customer.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'customer',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Added customer "${name}"`,
      metadata: { phone: input.phone, creditLimitMinor: input.creditLimit ?? null },
      at: now,
    });

    return inserted.id;
  });
}

export function updateCustomer(db: Db, id: number, input: CustomerInput, actor: Actor): void {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter the customer’s name.');

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(customers).where(eq(customers.id, id)).get();
    if (!existing) throw new NotFoundError('Customer', id);

    const now = new Date();
    tx.update(customers)
      .set({
        name,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
        creditLimitMinor: input.creditLimit ?? null,
        updatedAt: now,
      })
      .where(eq(customers.id, id))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'customer',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Updated customer "${name}"`,
      metadata: { before: { name: existing.name }, after: { name } },
      at: now,
    });
  });
}

/**
 * Customers are archived, never deleted — their sales and ledger entries must
 * survive. Archiving is also refused while they still owe money, because an
 * archived debtor is how a debt gets quietly forgotten.
 */
export function setCustomerActive(db: Db, id: number, isActive: boolean, actor: Actor): void {
  writeTransaction(db, (tx) => {
    const existing = tx.select().from(customers).where(eq(customers.id, id)).get();
    if (!existing) throw new NotFoundError('Customer', id);

    if (!isActive) {
      const balance = getCustomerBalance(tx, id);
      if (balance !== 0) {
        throw new ConflictError(
          `${existing.name} still has an outstanding balance. Settle it before archiving them.`,
        );
      }
    }

    const now = new Date();
    tx.update(customers).set({ isActive, updatedAt: now }).where(eq(customers.id, id)).run();

    writeAudit(tx, {
      action: isActive ? 'RESTORE' : 'ARCHIVE',
      entityType: 'customer',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${isActive ? 'Restored' : 'Archived'} customer "${existing.name}"`,
      at: now,
    });
  });
}

// --- reads ----------------------------------------------------------------

export interface CustomerListItem {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  creditLimit: Minor | null;
  balance: Minor;
  headroom: Minor | null;
  overLimit: boolean;
  isActive: boolean;
}

/**
 * The outer customer's id, written out with its table name.
 *
 * Drizzle omits the table qualifier for a query's primary table when the query
 * has no joins, so a bare interpolation renders as an unqualified column name —
 * which SQLite binds to the SUBQUERY's table instead, quietly making the
 * subquery uncorrelated. See the note on listCategories in catalog.service.ts.
 */
const CUSTOMER_ID = sql`customers.id`;

export const CUSTOMER_SORTS = ['name', 'balance'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export interface CustomerQuery {
  search?: string;
  includeInactive?: boolean;
  /** 'active' or 'archived'. Narrower than `includeInactive`, which widens. */
  customerStatus?: 'active' | 'archived';
  /**
   * What the customer owes.
   *
   * `owing` is a real receivable balance read from the ledger, not a flag
   * somebody set on the record — so "customers who owe" can never drift from
   * what the accounts say is owed.
   */
  balanceState?: 'owing' | 'zero' | 'credit';
  /** @deprecated Use `balanceState: 'owing'`. Kept for existing callers. */
  owingOnly?: boolean;
  sort?: CustomerSort;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * A customer's receivable balance, as SQL.
 *
 * The same sum `getAllCustomerBalances` performs, expressed where the database
 * can filter and sort on it. Without this, "who owes me" was answered by
 * fetching a page of customers and dropping the ones that did not owe — so a
 * shop with more customers than a page saw only part of its own debt.
 */
const customerBalanceSql = sql<number>`(
  SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)
  FROM journal_lines jl
  JOIN accounts a ON a.id = jl.account_id
  WHERE jl.customer_id = ${CUSTOMER_ID}
    AND a.code = ${ACCOUNT_CODES.ACCOUNTS_RECEIVABLE}
)`;

function customerConditions(query: CustomerQuery): SQL[] {
  const conditions: SQL[] = [];

  if (query.customerStatus === 'active') conditions.push(eq(customers.isActive, true));
  else if (query.customerStatus === 'archived') conditions.push(eq(customers.isActive, false));
  else if (!query.includeInactive) conditions.push(eq(customers.isActive, true));

  const state = query.balanceState ?? (query.owingOnly ? 'owing' : undefined);
  if (state === 'owing') conditions.push(sql`${customerBalanceSql} > 0`);
  if (state === 'zero') conditions.push(sql`${customerBalanceSql} = 0`);
  if (state === 'credit') conditions.push(sql`${customerBalanceSql} < 0`);

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${customers.name}) LIKE ${term}`,
      sql`lower(COALESCE(${customers.phone}, '')) LIKE ${term}`,
      sql`lower(COALESCE(${customers.email}, '')) LIKE ${term}`,
    );
    if (match) conditions.push(match);
  }

  return conditions;
}

export function listCustomers(db: Db, query: CustomerQuery = {}): CustomerListItem[] {
  const conditions = customerConditions(query);

  const ascending = (query.direction ?? 'asc') === 'asc';
  const orderBy =
    query.sort === 'balance'
      ? [ascending ? sql`${customerBalanceSql} ASC` : sql`${customerBalanceSql} DESC`,
         sql`lower(${customers.name}) ASC`]
      : [ascending ? sql`lower(${customers.name}) ASC` : sql`lower(${customers.name}) DESC`];

  const base = db.select().from(customers);
  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(...orderBy)
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0)
    .all();

  const balances = getAllCustomerBalances(db);

  const items = rows.map((row): CustomerListItem => {
    const balance = balances.get(row.id) ?? minor(0);
    const creditLimit = row.creditLimitMinor === null ? null : minor(row.creditLimitMinor);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      address: row.address,
      notes: row.notes,
      creditLimit,
      balance,
      headroom: creditHeadroom(creditLimit, balance),
      overLimit: creditLimit !== null && balance > creditLimit,
      isActive: row.isActive,
    };
  });

  return items;
}

/** How many customers match, ignoring the page. */
export function countCustomers(db: Db, query: CustomerQuery = {}): number {
  const conditions = customerConditions(query);
  const base = db.select({ total: sql<number>`COUNT(*)` }).from(customers);
  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();
  return row?.total ?? 0;
}

/**
 * Just enough to fill a filter dropdown.
 *
 * `listCustomers` does real work per row — a receivable balance read from the ledger — which is right for
 * the table and wasted on a `<select>` that needs a name and an id. It also
 * makes the cap matter: a list function truncated at its page size would leave
 * entries missing from the dropdown with nothing to say so, and a filter that
 * cannot offer a value the shop actually has is a dead end.
 */
export interface PartyOption {
  id: number;
  name: string;
  isActive: boolean;
}

export function listCustomerOptions(db: Db, includeInactive = false): PartyOption[] {
  const base = db
    .select({ id: customers.id, name: customers.name, isActive: customers.isActive })
    .from(customers);

  return (includeInactive ? base : base.where(eq(customers.isActive, true)))
    .orderBy(sql`lower(${customers.name}) ASC`)
    .all();
}

export function getCustomer(db: Db, id: number): CustomerListItem {
  const row = db.select().from(customers).where(eq(customers.id, id)).get();
  if (!row) throw new NotFoundError('Customer', id);

  const balance = getCustomerBalance(db, id);
  const creditLimit = row.creditLimitMinor === null ? null : minor(row.creditLimitMinor);

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    creditLimit,
    balance,
    headroom: creditHeadroom(creditLimit, balance),
    overLimit: creditLimit !== null && balance > creditLimit,
    isActive: row.isActive,
  };
}
