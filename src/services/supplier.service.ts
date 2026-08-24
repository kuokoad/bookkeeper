import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
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

export function listSuppliers(
  db: Db,
  query: { search?: string; includeInactive?: boolean; owingOnly?: boolean } = {},
): SupplierListItem[] {
  const conditions: SQL[] = [];
  if (!query.includeInactive) conditions.push(eq(suppliers.isActive, true));

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${suppliers.name}) LIKE ${term}`,
      sql`lower(COALESCE(${suppliers.phone}, '')) LIKE ${term}`,
    );
    if (match) conditions.push(match);
  }

  const base = db.select().from(suppliers);
  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(asc(suppliers.name))
    .all();

  const balances = getAllSupplierBalances(db);

  const items = rows.map((row) => ({
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

  return query.owingOnly ? items.filter((item) => item.balance > 0) : items;
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
