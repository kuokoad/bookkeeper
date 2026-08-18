import { and, desc, eq, like, or } from 'drizzle-orm';

import {
  customers,
  journalEntries,
  products,
  purchases,
  sales,
  suppliers,
} from '@/db/schema';
import type { Db } from '@/db/types';
import { can, type Principal } from '@/lib/auth/permissions';
import { minor, type Minor } from '@/domain/money';

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
  kind: 'product' | 'customer' | 'supplier' | 'sale' | 'purchase' | 'journal';
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
  // Escape the wildcards so a search for "50%" means what it says.
  return `%${query.replace(/[%_]/g, (char) => `\\${char}`)}%`;
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
        .where(or(like(products.name, term), like(products.sku, term)))
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

  if (can(user, 'customers', 'view')) {
    add(
      'Customers',
      db
        .select({ id: customers.id, name: customers.name, phone: customers.phone })
        .from(customers)
        .where(or(like(customers.name, term), like(customers.phone, term)))
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
        .where(or(like(suppliers.name, term), like(suppliers.phone, term)))
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
        .where(or(like(sales.receiptNo, term), like(customers.name, term), like(sales.note, term)))
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
            like(purchases.purchaseNo, term),
            like(purchases.invoiceNo, term),
            like(suppliers.name, term),
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
        .where(and(or(like(journalEntries.entryNo, term), like(journalEntries.memo, term))))
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
