import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  getStockLedger,
  verifyStockAgainstLedger,
  getInventoryValue,
} from '@/services/inventory.service';
import { getStockSummary, listProducts } from '@/services/catalog.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { formatDateTime, money, quantity } from '@/lib/format';
import { qty as makeQty } from '@/domain/quantity';
import { minor } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { EmptyRow, TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

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
  searchParams: Promise<{ product?: string }>;
}) {
  const user = await requirePageAccess('inventory', 'view');
  const params = await searchParams;

  const productId = params.product ? Number(params.product) : undefined;
  const filterProductId = Number.isInteger(productId) && productId! > 0 ? productId : undefined;

  const ledger = getStockLedger(db, {
    ...(filterProductId !== undefined ? { productId: filterProductId } : {}),
    limit: 100,
  });

  const summary = getStockSummary(db);
  const lowStock = listProducts(db, { lowStockOnly: true });

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

  // One product by id, not the whole catalogue filtered in JavaScript.
  const focusProduct = filterProductId
    ? listProducts(db, { includeInactive: true, id: filterProductId, limit: 1 })[0]
    : undefined;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Inventory"
        description="Every movement of stock, and why it moved."
        actions={
          can(user, 'inventory', 'create') ? (
            <>
              <Link href="/inventory/adjustments">
                <Button variant="secondary" size="sm">
                  Adjustments
                </Button>
              </Link>
              <Link href="/inventory/adjustments/new">
                <Button size="sm">New adjustment</Button>
              </Link>
            </>
          ) : (
            <Link href="/inventory/adjustments">
              <Button variant="secondary" size="sm">
                Adjustments
              </Button>
            </Link>
          )
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
        <Stat label="Stock value" value={money(summary.totalStockValue)} hint="Weighted average cost" />
        <Stat label="Tracked products" value={String(summary.trackedCount)} />
        <Stat
          label="Low stock"
          value={String(summary.lowStockCount)}
          tone={summary.lowStockCount > 0 ? 'warning' : 'default'}
        />
        <Stat
          label="Out of stock"
          value={String(summary.outOfStockCount)}
          tone={summary.outOfStockCount > 0 ? 'danger' : 'default'}
        />
      </div>

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
                      {item.outOfStock ? <Badge tone="danger">Out</Badge> : <Badge tone="warning">Low</Badge>}
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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="ledger-heading" className="text-sm font-semibold text-content">
            Stock ledger
            {focusProduct && (
              <span className="ml-2 font-normal text-content-muted">— {focusProduct.name}</span>
            )}
          </h2>
          {filterProductId !== undefined && (
            <Link href="/inventory" className="text-xs font-medium text-accent hover:underline">
              Show all products
            </Link>
          )}
        </div>

        {ledger.length === 0 ? (
          <EmptyState
            title="No stock movements yet"
            description="Once you record opening stock, a purchase or a sale, every change will appear here with its running balance."
            action={
              can(user, 'inventory', 'create') ? (
                <Link href="/inventory/adjustments/new">
                  <Button>Record opening stock</Button>
                </Link>
              ) : null
            }
          />
        ) : (
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
        )}
      </section>

      <p className="mt-4 text-xs text-content-subtle">
        This ledger is the source of truth for stock. The balance shown on each row is the position
        immediately after that movement, so any figure on the Products page can be traced back to
        the exact line that produced it.
      </p>
    </div>
  );
}
