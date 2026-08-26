import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import { accounts, journalLines, suppliers } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * Suppliers and what the shop owes them.
 *
 * Mirror image of the customer service: no balance is stored, it is derived
 * from the Accounts Payable journal lines tagged with the supplier's id. The
 * sum of all supplier balances therefore equals the A/P control account, which
 * the test suite asserts.
 */

export interface SupplierInput {
  name: string;
  contactPerson?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  address?: string | undefined;
  notes?: string | undefined;
}

/**
 * What the shop owes this supplier.
 *
 * A/P is a credit-normal account: credits increase what is owed (a purchase on
 * credit), debits reduce it (a payment). So the balance is credits minus debits.
 */
export function getSupplierBalance(tx: Tx | Db, supplierId: number): Minor {
  const row = tx
    .select({
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalLines.supplierId, supplierId),
        eq(accounts.code, ACCOUNT_CODES.ACCOUNTS_PAYABLE),
      ),
    )
    .get();

  return minor((row?.credit ?? 0) - (row?.debit ?? 0));
}

export function getAllSupplierBalances(db: Db): Map<number, Minor> {
  const rows = db
    .select({
      supplierId: journalLines.supplierId,
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(accounts.code, ACCOUNT_CODES.ACCOUNTS_PAYABLE))
    .groupBy(journalLines.supplierId)
    .all();

  const balances = new Map<number, Minor>();
  for (const row of rows) {
    if (row.supplierId === null) continue;
    balances.set(row.supplierId, minor(row.credit - row.debit));
  }
  return balances;
}

/** Total the shop owes everyone — the accounts payable figure. */
export function getTotalPayables(db: Db): Minor {
  let total = 0;
  for (const balance of getAllSupplierBalances(db).values()) total += balance;
  return minor(total);
}

export function createSupplier(db: Db, input: SupplierInput, actor: Actor): number {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter the supplier’s name.');

  return writeTransaction(db, (tx) => {
    const now = new Date();
    const inserted = tx
      .insert(suppliers)
      .values({
        name,
        contactPerson: input.contactPerson?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
        isActive: true,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: suppliers.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the supplier.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'supplier',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Added supplier "${name}"`,
      at: now,
    });

    return inserted.id;
  });
}

export function updateSupplier(db: Db, id: number, input: SupplierInput, actor: Actor): void {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter the supplier’s name.');

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(suppliers).where(eq(suppliers.id, id)).get();
    if (!existing) throw new NotFoundError('Supplier', id);

    const now = new Date();
    tx.update(suppliers)
      .set({
        name,
        contactPerson: input.contactPerson?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        notes: input.notes?.trim() || null,
        updatedAt: now,
      })
      .where(eq(suppliers.id, id))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'supplier',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Updated supplier "${name}"`,
      metadata: { before: { name: existing.name }, after: { name } },
      at: now,
    });
  });
}

/** Archiving is refused while money is still owed — an archived creditor is a forgotten debt. */
export function setSupplierActive(db: Db, id: number, isActive: boolean, actor: Actor): void {
  writeTransaction(db, (tx) => {
    const existing = tx.select().from(suppliers).where(eq(suppliers.id, id)).get();
    if (!existing) throw new NotFoundError('Supplier', id);

    if (!isActive && getSupplierBalance(tx, id) !== 0) {
      throw new ConflictError(
        `You still owe ${existing.name}. Settle the balance before archiving them.`,
      );
    }

    const now = new Date();
    tx.update(suppliers).set({ isActive, updatedAt: now }).where(eq(suppliers.id, id)).run();

    writeAudit(tx, {
      action: isActive ? 'RESTORE' : 'ARCHIVE',
      entityType: 'supplier',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${isActive ? 'Restored' : 'Archived'} supplier "${existing.name}"`,
      at: now,
    });
  });
}

// --- reads ----------------------------------------------------------------

export interface SupplierListItem {
  id: number;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  balance: Minor;
  isActive: boolean;
}

/**
 * The outer supplier's id, written out with its table name.
 *
 * Drizzle omits the table qualifier for a query's primary table when the query
 * has no joins, so a bare interpolation renders as an unqualified column name —
 * which SQLite binds to the SUBQUERY's table instead, quietly making the
 * subquery uncorrelated. See the note on listCategories in catalog.service.ts.
 */
const SUPPLIER_ID = sql`suppliers.id`;

export const SUPPLIER_SORTS = ['name', 'balance'] as const;
export type SupplierSort = (typeof SUPPLIER_SORTS)[number];

export interface SupplierQuery {
  search?: string;
  includeInactive?: boolean;
  /** 'active' or 'archived'. Narrower than `includeInactive`, which widens. */
  supplierStatus?: 'active' | 'archived';
  /**
   * What the shop owes them.
   *
   * `owing` is a real payable balance read from the ledger, so "suppliers we
   * owe" is derived from the accounts rather than from a flag on the record.
   */
  balanceState?: 'owing' | 'zero' | 'credit';
  /** @deprecated Use `balanceState: 'owing'`. Kept for existing callers. */
  owingOnly?: boolean;
  sort?: SupplierSort;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/**
 * What the shop owes one supplier, as SQL.
 *
 * Accounts Payable is credit-normal, so a positive balance here is money owed:
 * credits minus debits, the mirror of the customer-side expression.
 */
const supplierBalanceSql = sql<number>`(
  SELECT COALESCE(SUM(jl.credit_minor - jl.debit_minor), 0)
  FROM journal_lines jl
  JOIN accounts a ON a.id = jl.account_id
  WHERE jl.supplier_id = ${SUPPLIER_ID}
    AND a.code = ${ACCOUNT_CODES.ACCOUNTS_PAYABLE}
)`;

function supplierConditions(query: SupplierQuery): SQL[] {
  const conditions: SQL[] = [];

  if (query.supplierStatus === 'active') conditions.push(eq(suppliers.isActive, true));
  else if (query.supplierStatus === 'archived') conditions.push(eq(suppliers.isActive, false));
  else if (!query.includeInactive) conditions.push(eq(suppliers.isActive, true));

  const state = query.balanceState ?? (query.owingOnly ? 'owing' : undefined);
  if (state === 'owing') conditions.push(sql`${supplierBalanceSql} > 0`);
  if (state === 'zero') conditions.push(sql`${supplierBalanceSql} = 0`);
  if (state === 'credit') conditions.push(sql`${supplierBalanceSql} < 0`);

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${suppliers.name}) LIKE ${term}`,
      sql`lower(COALESCE(${suppliers.phone}, '')) LIKE ${term}`,
      sql`lower(COALESCE(${suppliers.contactPerson}, '')) LIKE ${term}`,
      sql`lower(COALESCE(${suppliers.email}, '')) LIKE ${term}`,
    );
    if (match) conditions.push(match);
  }

  return conditions;
}

export function listSuppliers(db: Db, query: SupplierQuery = {}): SupplierListItem[] {
  const conditions = supplierConditions(query);

  const ascending = (query.direction ?? 'asc') === 'asc';
  const orderBy =
    query.sort === 'balance'
      ? [
          ascending ? sql`${supplierBalanceSql} ASC` : sql`${supplierBalanceSql} DESC`,
          sql`lower(${suppliers.name}) ASC`,
        ]
      : [ascending ? sql`lower(${suppliers.name}) ASC` : sql`lower(${suppliers.name}) DESC`];

  const base = db.select().from(suppliers);
  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(...orderBy)
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0)
    .all();

  const balances = getAllSupplierBalances(db);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    contactPerson: row.contactPerson,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    balance: balances.get(row.id) ?? minor(0),
    isActive: row.isActive,
  }));
}

/** How many suppliers match, ignoring the page. */
export function countSuppliers(db: Db, query: SupplierQuery = {}): number {
  const conditions = supplierConditions(query);
  const base = db.select({ total: sql<number>`COUNT(*)` }).from(suppliers);
  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();
  return row?.total ?? 0;
}

/**
 * Just enough to fill a filter dropdown.
 *
 * `listSuppliers` does real work per row — a payable balance read from the ledger — which is right for
 * the table and wasted on a `<select>` that needs a name and an id. It also
 * makes the cap matter: a list function truncated at its page size would leave
 * entries missing from the dropdown with nothing to say so, and a filter that
 * cannot offer a value the shop actually has is a dead end.
 */
export interface SupplierOption {
  id: number;
  name: string;
  isActive: boolean;
}

export function listSupplierOptions(db: Db, includeInactive = false): SupplierOption[] {
  const base = db
    .select({ id: suppliers.id, name: suppliers.name, isActive: suppliers.isActive })
    .from(suppliers);

  return (includeInactive ? base : base.where(eq(suppliers.isActive, true)))
    .orderBy(sql`lower(${suppliers.name}) ASC`)
    .all();
}

export function getSupplier(db: Db, id: number): SupplierListItem {
  const row = db.select().from(suppliers).where(eq(suppliers.id, id)).get();
  if (!row) throw new NotFoundError('Supplier', id);

  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contactPerson,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    balance: getSupplierBalance(db, id),
    isActive: row.isActive,
  };
}
