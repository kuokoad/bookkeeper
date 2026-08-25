import { and, asc, desc, eq, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';

import {
  customers,
  journalEntries,
  productBatches,
  products,
  purchases,
  sales,
  suppliers,
} from '@/db/schema';
import type { Db } from '@/db/types';
import { can, type Principal } from '@/lib/auth/permissions';
import { minor, type Minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { formatDate, quantity } from '@/lib/format';

/**
 * Searching across the shop's records.
 *
 * **Permission is applied per record type, not to the results.** Filtering
 * afterwards would still have run the query, and a count or a timing difference
 * can disclose the existence of records a person may not see. A type the user
 * cannot view is never queried at all.
 *
 * Matching is a plain substring, case-insensitive. Full-text search would be
 * faster on a large database, but this is one shop: the tables are thousands of
 * rows, every column searched is indexed or tiny, and a second index to maintain
 * is a second thing that can drift from the data.
 */

export interface SearchHit {
  kind: 'product' | 'batch' | 'customer' | 'supplier' | 'sale' | 'purchase' | 'journal';
  id: number;
  title: string;
  detail: string;
  href: string;
  amount?: Minor;
}

export interface SearchResults {
  query: string;
  groups: { label: string; hits: SearchHit[] }[];
  total: number;
  /** True when a group hit the cap, so the page can say so rather than imply completeness. */
  truncated: boolean;
}

const PER_GROUP = 8;

/** SQLite LIKE is case-insensitive for ASCII by default. */
function pattern(query: string): string {
  // Escape the wildcards so a search for "50%" means what it says. The
  // backslash is only an escape because `matches` below says ESCAPE '\' — see
  // the note there.
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * `column LIKE pattern ESCAPE '\'`.
 *
 * SQLite has NO default escape character. Without the clause the backslashes
 * `pattern` inserts are matched literally, so a search for "50%" looked for the
 * four characters `50\%` and found nothing — the escaping meant to stop the
 * wildcard matching everything instead stopped it matching anything.
 *
 * Written as raw SQL because drizzle's `like()` helper has nowhere to put the
 * clause. The pattern is still a bound parameter, not interpolated text.
 */
function matches(column: AnyColumn, term: string): SQL {
  // `\\` in this template literal emits ONE backslash into the SQL. Written as
  // `'\'` it would emit `'''`, and SQLite rejects that as not a single
  // character — which is how the missing clause was noticed at all.
  return sql`${column} LIKE ${term} ESCAPE '\\'`;
}

export function search(db: Db, rawQuery: string, user: Principal): SearchResults {
  const query = rawQuery.trim();
  if (query.length < 2) {
    return { query, groups: [], total: 0, truncated: false };
  }

  const term = pattern(query);
  const groups: { label: string; hits: SearchHit[] }[] = [];
  let truncated = false;

  const add = (label: string, hits: SearchHit[]) => {
    if (hits.length === 0) return;
    if (hits.length > PER_GROUP) truncated = true;
    groups.push({ label, hits: hits.slice(0, PER_GROUP) });
  };

  if (can(user, 'products', 'view')) {
    add(
      'Products',
      db
        .select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit })
        .from(products)
        .where(or(matches(products.name, term), matches(products.sku, term)))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'product' as const,
          id: row.id,
          title: row.name,
          detail: [row.sku, row.unit].filter(Boolean).join(' · '),
          href: `/products/${row.id}/edit`,
        })),
    );
  }

  if (can(user, 'products', 'view')) {
    /**
     * Batches, found by their own reference or by the product's name.
     *
     * The reference is what somebody is holding when a supplier telephones
     * about a bad lot, so an EXACT match is offered whatever state the crate is
     * in — a recall is precisely about stock that has already gone. Searching
     * the product name only offers crates still holding something, or every
     * product with a long history would bury its own row under dead batches.
     */
    const exactRef = matches(productBatches.batchRef, term);
    const byName = and(matches(products.name, term), sql`${productBatches.qtyMilli} <> 0`);

    add(
      'Batches',
      db
        .select({
          id: productBatches.id,
          batchRef: productBatches.batchRef,
          expiryDate: productBatches.expiryDate,
          qtyMilli: productBatches.qtyMilli,
          productName: products.name,
          unit: products.unit,
        })
        .from(productBatches)
        .innerJoin(products, eq(products.id, productBatches.productId))
        .where(or(exactRef, byName))
        .orderBy(asc(productBatches.expiryDate), asc(productBatches.id))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'batch' as const,
          id: row.id,
          title: row.batchRef,
          detail: [
            row.productName,
            `${quantity(makeQty(row.qtyMilli), row.unit)} left`,
            row.expiryDate === null ? 'no date' : `expires ${formatDate(row.expiryDate)}`,
          ].join(' · '),
          href: `/inventory/batches/${row.id}`,
        })),
    );
  }

  if (can(user, 'customers', 'view')) {
    add(
      'Customers',
      db
        .select({ id: customers.id, name: customers.name, phone: customers.phone })
        .from(customers)
        .where(or(matches(customers.name, term), matches(customers.phone, term)))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'customer' as const,
          id: row.id,
          title: row.name,
          detail: row.phone ?? 'No phone number',
          href: `/customers/${row.id}`,
        })),
    );
  }

  if (can(user, 'suppliers', 'view')) {
    add(
      'Suppliers',
      db
        .select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone })
        .from(suppliers)
        .where(or(matches(suppliers.name, term), matches(suppliers.phone, term)))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'supplier' as const,
          id: row.id,
          title: row.name,
          detail: row.phone ?? 'No phone number',
          href: `/suppliers/${row.id}`,
        })),
    );
  }

  if (can(user, 'sales', 'view')) {
    add(
      'Receipts',
      db
        .select({
          id: sales.id,
          receiptNo: sales.receiptNo,
          businessDate: sales.businessDate,
          total: sales.totalMinor,
          customerName: customers.name,
        })
        .from(sales)
        .leftJoin(customers, eq(customers.id, sales.customerId))
        .where(or(matches(sales.receiptNo, term), matches(customers.name, term), matches(sales.note, term)))
        .orderBy(desc(sales.businessDate))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'sale' as const,
          id: row.id,
          title: row.receiptNo,
          detail: [row.businessDate, row.customerName].filter(Boolean).join(' · '),
          href: `/sales/${row.id}`,
          amount: minor(row.total),
        })),
    );
  }

  if (can(user, 'purchases', 'view')) {
    add(
      'Purchases',
      db
        .select({
          id: purchases.id,
          purchaseNo: purchases.purchaseNo,
          businessDate: purchases.businessDate,
          total: purchases.totalMinor,
          supplierName: suppliers.name,
        })
        .from(purchases)
        .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
        .where(
          or(
            matches(purchases.purchaseNo, term),
            matches(purchases.invoiceNo, term),
            matches(suppliers.name, term),
          ),
        )
        .orderBy(desc(purchases.businessDate))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'purchase' as const,
          id: row.id,
          title: row.purchaseNo,
          detail: [row.businessDate, row.supplierName].filter(Boolean).join(' · '),
          href: `/purchases/${row.id}`,
          amount: minor(row.total),
        })),
    );
  }

  // The ledger itself, for anyone allowed to look at it.
  if (can(user, 'accounts', 'view')) {
    add(
      'Journal entries',
      db
        .select({
          id: journalEntries.id,
          entryNo: journalEntries.entryNo,
          entryDate: journalEntries.entryDate,
          memo: journalEntries.memo,
        })
        .from(journalEntries)
        .where(and(or(matches(journalEntries.entryNo, term), matches(journalEntries.memo, term))))
        .orderBy(desc(journalEntries.entryDate))
        .limit(PER_GROUP + 1)
        .all()
        .map((row) => ({
          kind: 'journal' as const,
          id: row.id,
          title: row.entryNo,
          detail: [row.entryDate, row.memo].filter(Boolean).join(' · '),
          href: `/accounting/journal/${row.id}`,
        })),
    );
  }

  return {
    query,
    groups,
    total: groups.reduce((running, group) => running + group.hits.length, 0),
    truncated,
  };
}
