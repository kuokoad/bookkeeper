import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { countProducts, getStockSummary, listCategories, listProducts } from '@/services/catalog.service';
import { getSettings } from '@/services/settings.service';
import { listSupplierOptions } from '@/services/supplier.service';
import { money, quantity } from '@/lib/format';
import { buildQuery, clampPage, type ActiveFilter } from '@/lib/filters';
import { parseProductFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Products' };
export const dynamic = 'force-dynamic';

const STOCK_LABELS: Record<string, string> = {
  'in-stock': 'In stock',
  low: 'Low or out',
  out: 'Out of stock',
  negative: 'Negative stock',
};

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('products', 'view');
  const params = await searchParams;

  const { filters, page: requestedPage, pageSize, carried } = parseProductFilters(params);

  const total = countProducts(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const items = listProducts(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });

  const categories = listCategories(db);
  const suppliers = listSupplierOptions(db, true);

  /*
    Two summaries, because they answer two different questions and conflating
    them is what makes a filtered page misleading. The top row describes the
    SHOP — how much stock it holds, how much of it needs reordering — and must
    not shrink when the owner searches for one product. The line under the
    filter bar describes the SELECTION.
  */
  const shop = getStockSummary(db);
  const selection = getStockSummary(db, filters);

  const sort = filters.sort ?? 'name';
  const direction = filters.direction ?? 'asc';
  const canCreate = can(user, 'products', 'create');


  /*
    "Negative stock" is only offered when it can mean something: the shop allows
    it, or something has already gone negative. Otherwise it is a dropdown entry
    that always returns nothing — and when a product DOES go negative it is a
    recording error worth finding fast, so the option appears exactly then.
  */
  const negativeCount = countProducts(db, { stockStatus: 'negative' });
  const stockStatusOptions = [
    { value: 'in-stock', label: 'In stock' },
    { value: 'low', label: 'Low or out' },
    { value: 'out', label: 'Out of stock' },
    ...(negativeCount > 0 || getSettings(db).allowNegativeStock
      ? [{ value: 'negative', label: 'Negative stock' }]
      : []),
  ];
  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
  if (filters.categoryId !== undefined) {
    active.push({
      key: 'category',
      label: 'Category',
      value:
        categories.find((item) => item.id === filters.categoryId)?.name ??
        String(filters.categoryId),
    });
  }
  if (filters.supplierId !== undefined) {
    active.push({
      key: 'supplier',
      label: 'Supplier',
      value:
        suppliers.find((item) => item.id === filters.supplierId)?.name ??
        String(filters.supplierId),
    });
  }
  if (filters.stockStatus !== undefined) {
    active.push({ key: 'stock', label: 'Stock', value: STOCK_LABELS[filters.stockStatus] ?? '' });
  }
  if (filters.productStatus !== undefined) {
    active.push({
      key: 'archived',
      label: 'Product',
      value: filters.productStatus === 'archived' ? 'Archived' : 'Active',
    });
  }
  if (filters.expiring !== undefined) {
    active.push({
      key: 'expiring',
      label: 'Dates',
      value: filters.expiring === 'expired' ? 'Expired' : 'Expiring soon',
    });
  }

  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/products${buildQuery(carried)}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Products"
        description="What you sell, what it costs you, and how much is on the shelf."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            {canCreate ? (
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
            ) : null}
          </>
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

      {/* The shop as a whole. These do not move with the filter, on purpose. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Products" value={String(shop.productCount)} />
        <Stat
          label="Stock value"
          value={money(shop.totalStockValue)}
          hint="At weighted average cost"
        />
        <Stat
          label="Low stock"
          value={String(shop.lowStockCount)}
          tone={shop.lowStockCount > 0 ? 'warning' : 'default'}
        />
        <Stat
          label="Out of stock"
          value={String(shop.outOfStockCount)}
          tone={shop.outOfStockCount > 0 ? 'danger' : 'default'}
        />
      </div>

      {(filters.expiring === 'expired' || filters.expiring === 'soon') && (
        /*
          The dashboard sends people here, so the page has to say what it is
          showing. Without this the list looks like the whole catalogue with
          products mysteriously missing.
        */
        <Alert
          tone={filters.expiring === 'expired' ? 'danger' : 'warning'}
          className="mb-4"
          title={
            filters.expiring === 'expired'
              ? 'Showing products with stock that has expired'
              : 'Showing products with stock expiring soon'
          }
        >
          <p>
            {filters.expiring === 'expired'
              ? 'It cannot be sold. Record a stock adjustment with the reason "Expired" to take it off the shelf and out of the accounts.'
              : 'Still sellable, and worth moving first.'}{' '}
            <Link href="/products" className="font-medium text-accent hover:underline">
              Show everything
            </Link>
          </p>
        </Alert>
      )}

      <FilterBar
        basePath="/products"
        active={active}
        quick={[
          { label: 'Low stock', params: { stock: 'low' }, match: { stock: 'low' } },
          { label: 'Out of stock', params: { stock: 'out' }, match: { stock: 'out' } },
          { label: 'Expiring soon', params: { expiring: 'soon' }, match: { expiring: 'soon' } },
          { label: 'Archived', params: { archived: 'archived' }, match: { archived: 'archived' } },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Name, SKU or barcode',
            wide: true,
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
            key: 'supplier',
            label: 'Supplier',
            allLabel: 'All suppliers',
            options: suppliers.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'stock',
            label: 'Stock status',
            allLabel: 'Any stock level',
            options: stockStatusOptions,
          },
          {
            kind: 'select',
            key: 'archived',
            label: 'Product status',
            allLabel: 'Active only',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ],
          },
        ]}
      />

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
        <>
          {isFiltered && (
            <p className="mb-3 text-xs text-content-subtle">
              These {total} product(s) hold {money(selection.totalStockValue)} of stock —{' '}
              {selection.lowStockCount} low, {selection.outOfStockCount} out.
            </p>
          )}

          <TableWrap>
            <THead>
              <TH>
                <SortLink
                  basePath="/products"
                  values={carried}
                  column="name"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Product
                </SortLink>
              </TH>
              <TH>
                <SortLink
                  basePath="/products"
                  values={carried}
                  column="category"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Category
                </SortLink>
              </TH>
              <TH numeric>
                <SortLink
                  basePath="/products"
                  values={carried}
                  column="quantity"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  In stock
                </SortLink>
              </TH>
              <TH numeric>
                <SortLink
                  basePath="/products"
                  values={carried}
                  column="cost"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Avg cost
                </SortLink>
              </TH>
              <TH numeric>
                <SortLink
                  basePath="/products"
                  values={carried}
                  column="price"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Selling price
                </SortLink>
              </TH>
              <TH numeric>
                <SortLink
                  basePath="/products"
                  values={carried}
                  column="value"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Stock value
                </SortLink>
              </TH>
              <TH />
            </THead>
            <tbody>
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
                        {item.qtyOnHand < 0 ? (
                          <Badge tone="danger">Negative</Badge>
                        ) : item.outOfStock ? (
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

          <Pagination
            basePath="/products"
            values={carried}
            page={page}
            pageSize={pageSize}
            total={total}
            noun="product"
          />
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Stock quantities cannot be typed in directly. Every change comes from a purchase, a sale or
        a recorded stock adjustment, which is what lets any figure here be traced back to its
        source.
      </p>
    </div>
  );
}
