import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  countStockLedger,
  getStockLedger,
  listProductBatches,
  verifyStockAgainstLedger,
  getInventoryValue,
} from '@/services/inventory.service';
import {
  getStockSummary,
  listCategories,
  listProductOptions,
  listProducts,
} from '@/services/catalog.service';
import { listUsers } from '@/services/user.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { MOVEMENT_TYPES } from '@/db/schema/inventory';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { formatDate, formatDateTime, money, quantity, toBusinessDate } from '@/lib/format';
import { qty as makeQty } from '@/domain/quantity';
import { minor } from '@/domain/money';
import {
  buildQuery,
  clampPage,
  describeDateRange,
  type ActiveFilter,
} from '@/lib/filters';
import { parseStockMovementFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { EmptyRow, TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Inventory' };
export const dynamic = 'force-dynamic';

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING_STOCK: 'Opening stock',
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Return to supplier',
  SALE: 'Sale',
  SALE_RETURN: 'Customer return',
  ADJUSTMENT_IN: 'Adjustment in',
  ADJUSTMENT_OUT: 'Adjustment out',
};

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('inventory', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const { filters, range, preset, page: requestedPage, pageSize, carried } =
    parseStockMovementFilters(params, today);

  /*
    Filtering the LEDGER cannot change the stock it records. Every row already
    carries the running balance that was true when the movement happened, so
    narrowing the view to one product or one week shows fewer rows and the same
    balances. Nothing on this page recomputes a position from what is on screen.
  */
  const total = countStockLedger(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const ledger = getStockLedger(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });

  const summary = getStockSummary(db);
  const lowStock = listProducts(db, { stockStatus: 'low', sort: 'quantity', direction: 'asc', limit: 50 });

  const categories = listCategories(db);
  const products = listProductOptions(db, true);
  const staff = listUsers(db);

  // The crates behind the running balance, when the page is showing one product.
  const filterProductId = filters.productId;
  const batches =
    filterProductId === undefined ? [] : listProductBatches(db, filterProductId, today);
  const focusProduct =
    filterProductId === undefined
      ? undefined
      : listProducts(db, { includeInactive: true, id: filterProductId, limit: 1 })[0];
  const batchUnit = focusProduct?.unit ?? '';

  // The headline integrity check, computed live rather than assumed — but from
  // the ledger's last recorded balance, not by replaying every movement the shop
  // has ever made. This page is visited constantly; a full replay reads the
  // whole history of every product each time and gets slower for ever.
  // `npm run preflight` does the replay, where waiting for it is the point.
  const verifications = verifyStockAgainstLedger(db);
  const drifted = verifications.filter((verification) => !verification.ok);
  const inventoryCache = getInventoryValue(db);
  const inventoryGl = getAccountBalanceByCode(db, ACCOUNT_CODES.INVENTORY);
  const ledgerMatchesGl = inventoryCache === inventoryGl;

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
  if (filterProductId !== undefined) {
    active.push({
      key: 'product',
      label: 'Product',
      value: focusProduct?.name ?? String(filterProductId),
    });
  }
  if (filters.categoryId !== undefined) {
    active.push({
      key: 'category',
      label: 'Category',
      value:
        categories.find((item) => item.id === filters.categoryId)?.name ??
        String(filters.categoryId),
    });
  }
  if (filters.movementType !== undefined) {
    active.push({
      key: 'movement',
      label: 'Movement',
      value: MOVEMENT_LABELS[filters.movementType] ?? filters.movementType,
    });
  }
  if (filters.userId !== undefined) {
    active.push({
      key: 'user',
      label: 'By',
      value: staff.find((item) => item.id === filters.userId)?.displayName ?? String(filters.userId),
    });
  }
  if (preset !== 'all') {
    active.push({
      key: 'period',
      label: 'Period',
      value: describeDateRange(range, preset, today),
      alsoClears: ['from', 'to'],
    });
  }

  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/stock-movements${buildQuery(carried)}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Inventory"
        description="Every movement of stock, and why it moved."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            <Link href="/inventory/adjustments">
              <Button variant="secondary" size="sm">
                Adjustments
              </Button>
            </Link>
            {can(user, 'inventory', 'create') ? (
              <Link href="/inventory/adjustments/new">
                <Button size="sm">New adjustment</Button>
              </Link>
            ) : null}
          </>
        }
      />

      {drifted.length > 0 && (
        <Alert tone="danger" title="Stock records disagree with the ledger" className="mb-4">
          {drifted.length} product(s) have a cached stock figure that does not match the last
          balance recorded in the ledger. This should never happen. Affected:{' '}
          {drifted.map((item) => item.productName).join(', ')}. Run{' '}
          <code>npm run preflight</code> to replay the full movement history and see where the two
          parted company.
        </Alert>
      )}

      {!ledgerMatchesGl && (
        <Alert tone="danger" title="Inventory does not match the accounts" className="mb-4">
          Stock is valued at {money(inventoryCache)} but the Inventory ledger account holds{' '}
          {money(inventoryGl)}. Please report this before recording anything else.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Stock value" icon="inventory" value={money(summary.totalStockValue)} hint="Weighted average cost" />
        <Stat label="Tracked products" icon="products" value={String(summary.trackedCount)} />
        <Stat
          label="Low stock" icon="warning"
          value={String(summary.lowStockCount)}
          tone={summary.lowStockCount > 0 ? 'warning' : 'default'}
        />
        <Stat
          label="Out of stock" icon="warning"
          value={String(summary.outOfStockCount)}
          tone={summary.outOfStockCount > 0 ? 'danger' : 'default'}
        />
      </div>

      {/*
        The batches of ONE product, and only when the page is showing one.
        Listed in the order stock will be taken from them, so the shelf reads
        the same way the till draws — see `listProductBatches`.
      */}
      {filterProductId !== undefined && batches.length > 0 && (
        <section className="mb-6" aria-labelledby="batches-heading">
          <h2 id="batches-heading" className="mb-3 text-sm font-semibold text-content">
            Batches on the shelf
          </h2>
          <TableWrap>
            <THead>
              <TH>Batch</TH>
              <TH>Expires</TH>
              <TH>From</TH>
              <TH numeric>Remaining</TH>
              <TH numeric>Days left</TH>
            </THead>
            <tbody>
              {batches.map((batch) => (
                <TR key={batch.id}>
                  <TD>
                    <Link
                      href={`/inventory/batches/${batch.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {batch.batchRef}
                    </Link>
                  </TD>
                  <TD>
                    {batch.expiryDate === null ? (
                      <span className="text-content-subtle">No date</span>
                    ) : (
                      formatDate(batch.expiryDate)
                    )}
                  </TD>
                  <TD>{batch.supplierName ?? <span className="text-content-subtle">—</span>}</TD>
                  <TD numeric>{quantity(makeQty(batch.qtyMilli), batchUnit)}</TD>
                  <TD numeric>
                    {batch.daysLeft === null ? (
                      <span className="text-content-subtle">—</span>
                    ) : batch.daysLeft < 0 ? (
                      <Badge tone="danger">Expired</Badge>
                    ) : batch.daysLeft <= 30 ? (
                      <span className="font-medium text-warning">{batch.daysLeft}</span>
                    ) : (
                      <span className="text-content">{batch.daysLeft}</span>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>
        </section>
      )}

      {lowStock.length > 0 && (
        <section className="mb-6" aria-labelledby="low-stock-heading">
          <h2 id="low-stock-heading" className="mb-3 text-sm font-semibold text-content">
            Running low
          </h2>
          <TableWrap>
            <THead>
              <TH>Product</TH>
              <TH numeric>In stock</TH>
              <TH numeric>Reorder at</TH>
              <TH />
            </THead>
            <tbody>
              {lowStock.map((item) => (
                <TR key={item.id}>
                  <TD>
                    <span className="font-medium text-content">{item.name}</span>
                  </TD>
                  <TD numeric>
                    <span className="inline-flex items-center gap-2">
                      {quantity(item.qtyOnHand, item.unit)}
                      {item.outOfStock ? (
                        <Badge tone="danger">Out</Badge>
                      ) : (
                        <Badge tone="warning">Low</Badge>
                      )}
                    </span>
                  </TD>
                  <TD numeric>
                    {item.minStock === null ? (
                      <span className="text-content-subtle">Shop default</span>
                    ) : (
                      quantity(item.minStock, item.unit)
                    )}
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Link
                        href={`/inventory?product=${item.id}`}
                        className="text-xs font-medium text-accent hover:underline"
                      >
                        History
                      </Link>
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>
        </section>
      )}

      <section aria-labelledby="ledger-heading">
        <h2 id="ledger-heading" className="mb-3 text-sm font-semibold text-content">
          Stock ledger
          {focusProduct && (
            <span className="ml-2 font-normal text-content-muted">— {focusProduct.name}</span>
          )}
        </h2>

        <FilterBar
          basePath="/inventory"
          dateRange={{ preset, from: range.from, to: range.to }}
          active={active}
          quick={[
            { label: 'Sales', params: { movement: 'SALE' }, match: { movement: 'SALE' } },
            { label: 'Purchases', params: { movement: 'PURCHASE' }, match: { movement: 'PURCHASE' } },
            {
              label: 'Customer returns',
              params: { movement: 'SALE_RETURN' },
              match: { movement: 'SALE_RETURN' },
            },
            {
              label: 'Adjustments out',
              params: { movement: 'ADJUSTMENT_OUT' },
              match: { movement: 'ADJUSTMENT_OUT' },
            },
          ]}
          fields={[
            {
              kind: 'search',
              key: 'q',
              label: 'Search',
              placeholder: 'Product, SKU, reference or note',
              wide: true,
            },
            {
              kind: 'select',
              key: 'product',
              label: 'Product',
              allLabel: 'All products',
              options: products.map((item) => ({ value: String(item.id), label: item.name })),
            },
            {
              kind: 'select',
              key: 'category',
              label: 'Category',
              allLabel: 'All categories',
              options: categories.map((item) => ({ value: String(item.id), label: item.name })),
            },
            {
              kind: 'select',
              key: 'movement',
              label: 'Movement type',
              allLabel: 'All movements',
              options: MOVEMENT_TYPES.map((type) => ({
                value: type,
                label: MOVEMENT_LABELS[type] ?? type,
              })),
            },
            {
              kind: 'select',
              key: 'user',
              label: 'Recorded by',
              allLabel: 'Anyone',
              options: staff.map((item) => ({ value: String(item.id), label: item.displayName })),
            },
          ]}
        />

        {ledger.length === 0 ? (
          <EmptyState
            title={isFiltered ? 'No movements match these filters' : 'No stock movements yet'}
            description={
              isFiltered
                ? 'Try widening the dates, or clear a filter to see more.'
                : 'Once you record opening stock, a purchase or a sale, every change will appear here with its running balance.'
            }
            action={
              can(user, 'inventory', 'create') && !isFiltered ? (
                <Link href="/inventory/adjustments/new">
                  <Button>Record opening stock</Button>
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <TableWrap>
              <THead>
                <TH>When</TH>
                <TH>Product</TH>
                <TH>Movement</TH>
                <TH>Reference</TH>
                <TH numeric>In</TH>
                <TH numeric>Out</TH>
                <TH numeric>Value</TH>
                <TH numeric>Balance</TH>
                <TH numeric>Stock value</TH>
              </THead>
              <tbody>
                {ledger.length === 0 && <EmptyRow colSpan={9}>Nothing to show.</EmptyRow>}
                {ledger.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <span className="whitespace-nowrap text-content-muted">
                        {formatDateTime(row.occurredAt)}
                      </span>
                    </TD>
                    <TD>
                      <span className="font-medium text-content">{row.productName}</span>
                    </TD>
                    <TD>
                      <Badge tone={row.qtyIn > 0 ? 'success' : 'warning'}>
                        {MOVEMENT_LABELS[row.movementType] ?? row.movementType}
                      </Badge>
                    </TD>
                    <TD>
                      <span className="text-xs text-content-subtle">{row.sourceRef ?? '—'}</span>
                    </TD>
                    <TD numeric>
                      {row.qtyIn > 0 ? quantity(makeQty(row.qtyIn), row.productUnit) : '—'}
                    </TD>
                    <TD numeric>
                      {row.qtyOut > 0 ? quantity(makeQty(row.qtyOut), row.productUnit) : '—'}
                    </TD>
                    <TD numeric>{money(minor(row.totalCost), { bare: true })}</TD>
                    <TD numeric>{quantity(makeQty(row.balanceQty), row.productUnit)}</TD>
                    <TD numeric>{money(minor(row.balanceValue), { bare: true })}</TD>
                  </TR>
                ))}
              </tbody>
            </TableWrap>

            <Pagination
              basePath="/inventory"
              values={carried}
              page={page}
              pageSize={pageSize}
              total={total}
              noun="movement"
            />
          </>
        )}
      </section>

      <p className="mt-4 text-xs text-content-subtle">
        This ledger is the source of truth for stock. The balance shown on each row is the position
        immediately after that movement, so any figure on the Products page can be traced back to
        the exact line that produced it. Filtering changes what you see, never what the shop holds.
      </p>
    </div>
  );
}
