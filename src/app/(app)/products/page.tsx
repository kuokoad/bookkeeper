import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getStockSummary, listCategories, listProducts } from '@/services/catalog.service';
import { money, quantity } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { EmptyRow, TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { ProductFilters } from './product-filters';

export const metadata: Metadata = { title: 'Products' };
export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    low?: string;
    expiring?: string;
    inactive?: string;
    created?: string;
    updated?: string;
  }>;
}) {
  const user = await requirePageAccess('products', 'view');
  const params = await searchParams;

  const categoryId = params.category ? Number(params.category) : undefined;
  const items = listProducts(db, {
    ...(params.q ? { search: params.q } : {}),
    ...(Number.isInteger(categoryId) ? { categoryId } : {}),
    lowStockOnly: params.low === '1',
    ...(params.expiring === 'expired' || params.expiring === 'soon'
      ? { expiring: params.expiring }
      : {}),
    includeInactive: params.inactive === '1',
  });

  const categories = listCategories(db);
  const summary = getStockSummary(db);
  const canCreate = can(user, 'products', 'create');
  const isFiltered = Boolean(
    params.q || params.category || params.low === '1' || params.expiring,
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Products"
        description="What you sell, what it costs you, and how much is on the shelf."
        actions={
          canCreate ? (
            <>
              <Link href="/products/categories">
                <Button variant="secondary" size="sm">
                  Categories
                </Button>
              </Link>
              <Link href="/products/new">
                <Button size="sm">Add product</Button>
              </Link>
            </>
          ) : null
        }
      />

      {params.created === '1' && (
        <Alert tone="success" className="mb-4">
          Product created. It starts with no stock — record a stock adjustment to enter opening
          stock.
        </Alert>
      )}
      {params.updated === '1' && (
        <Alert tone="success" className="mb-4">
          Product updated.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Products" value={String(summary.productCount)} />
        <Stat
          label="Stock value"
          value={money(summary.totalStockValue)}
          hint="At weighted average cost"
        />
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

      {(params.expiring === 'expired' || params.expiring === 'soon') && (
        /*
          The dashboard sends people here, so the page has to say what it is
          showing. Without this the list looks like the whole catalogue with
          products mysteriously missing.
        */
        <Alert
          tone={params.expiring === 'expired' ? 'danger' : 'warning'}
          className="mb-4"
          title={
            params.expiring === 'expired'
              ? 'Showing products with stock that has expired'
              : 'Showing products with stock expiring soon'
          }
        >
          <p>
            {params.expiring === 'expired'
              ? 'It cannot be sold. Record a stock adjustment with the reason "Expired" to take it off the shelf and out of the accounts.'
              : 'Still sellable, and worth moving first.'}{' '}
            <Link href="/products" className="font-medium text-accent hover:underline">
              Show everything
            </Link>
          </p>
        </Alert>
      )}

      <ProductFilters categories={categories} />

      {items.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No products match' : 'No products yet'}
          description={
            isFiltered
              ? 'Try a different search, or clear the filters to see everything.'
              : 'Add the things you sell. You can enter opening stock afterwards with a stock adjustment, so every figure traces back to a record.'
          }
          action={
            canCreate && !isFiltered ? (
              <Link href="/products/new">
                <Button>Add your first product</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <TableWrap className="mt-4">
          <THead>
            <TH>Product</TH>
            <TH>Category</TH>
            <TH numeric>In stock</TH>
            <TH numeric>Avg cost</TH>
            <TH numeric>Selling price</TH>
            <TH numeric>Stock value</TH>
            <TH />
          </THead>
          <tbody>
            {items.length === 0 && <EmptyRow colSpan={7}>Nothing to show.</EmptyRow>}
            {items.map((item) => (
              <TR key={item.id}>
                <TD>
                  <div className="font-medium text-content">{item.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-content-subtle">
                    {item.sku && <span>SKU {item.sku}</span>}
                    {item.barcode && <span>· {item.barcode}</span>}
                    {!item.isActive && <Badge tone="neutral">Archived</Badge>}
                  </div>
                </TD>
                <TD>
                  <span className="text-content-muted">{item.categoryName ?? '—'}</span>
                </TD>
                <TD numeric>
                  {item.trackInventory ? (
                    <span className="inline-flex items-center gap-2">
                      {quantity(item.qtyOnHand, item.unit)}
                      {item.outOfStock ? (
                        <Badge tone="danger">Out</Badge>
                      ) : item.lowStock ? (
                        <Badge tone="warning">Low</Badge>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-content-subtle">Not tracked</span>
                  )}
                </TD>
                <TD numeric>
                  {item.trackInventory && item.qtyOnHand !== 0 ? (
                    money(item.averageCost, { bare: true })
                  ) : (
                    <span className="text-content-subtle">—</span>
                  )}
                </TD>
                <TD numeric>{money(item.sellingPrice, { bare: true })}</TD>
                <TD numeric>{money(item.stockValue, { bare: true })}</TD>
                <TD>
                  <div className="flex justify-end gap-2 whitespace-nowrap">
                    <Link
                      href={`/inventory?product=${item.id}`}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      History
                    </Link>
                    {can(user, 'products', 'edit') && (
                      <Link
                        href={`/products/${item.id}/edit`}
                        className="text-xs font-medium text-accent hover:underline"
                      >
                        Edit
                      </Link>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Stock quantities cannot be typed in directly. Every change comes from a purchase, a sale or
        a recorded stock adjustment, which is what lets any figure here be traced back to its
        source.
      </p>
    </div>
  );
}
