import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  getStockMovementSummary,
  getStockValuation,
} from '@/services/reporting/operations.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { getExpiryAgeing } from '@/services/inventory.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { money, quantity, toBusinessDate } from '@/lib/format';
import { qty as makeQty } from '@/domain/quantity';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod, PeriodFilter, resolvePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';

export const metadata: Metadata = { title: 'Inventory report' };
export const dynamic = 'force-dynamic';

export default async function InventoryReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const { period, preset } = resolvePeriod(params.period, params.from, params.to, toBusinessDate());

  const valuation = getStockValuation(db);
  const ageing = getExpiryAgeing(db, toBusinessDate());
  const movement = getStockMovementSummary(db, period);
  const inventoryGl = getAccountBalanceByCode(db, ACCOUNT_CODES.INVENTORY);
  const matchesLedger = valuation.totalCostValue === inventoryGl;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Inventory report"
        description={`Valuation as at today · movement ${describePeriod(period, preset).toLowerCase()}`}
        actions={
          <ReportActions csvHref={`/api/reports/inventory?from=${period.from}&to=${period.to}`} />
        }
      />

      {!matchesLedger && (
        <Alert tone="danger" title="Stock value does not match the accounts" className="mb-4">
          Stock is valued at {money(valuation.totalCostValue)} but the Inventory ledger account
          holds {money(inventoryGl)}. Please report this.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Stock at cost"
          value={money(valuation.totalCostValue)}
          hint="What you paid for it"
        />
        <Stat
          label="Stock at selling price"
          value={money(valuation.totalRetailValue)}
          hint="If it all sold"
        />
        <Stat
          label="Profit if all sold"
          value={money(valuation.totalPotentialProfit)}
          tone="success"
        />
        <Stat
          label="Needs attention"
          value={String(valuation.lowStockCount + valuation.outOfStockCount)}
          tone={valuation.outOfStockCount > 0 ? 'danger' : valuation.lowStockCount > 0 ? 'warning' : 'default'}
          hint={`${valuation.lowStockCount} low, ${valuation.outOfStockCount} out`}
        />
      </div>

      {/*
        Dates, and only if the shop keeps any. QUANTITY, never value: a batch
        has never carried a cost — value is weighted-average and pooled per
        product — so "the value of stock expiring within 7 days" is a figure
        this application cannot honestly produce.
      */}
      {ageing.some((row) => row.batchCount > 0) && (
        <>
          <h2 className="mb-3 text-sm font-semibold text-content">How long the stock has left</h2>
          <TableWrap className="mb-8">
            <THead>
              <TH>When it runs out</TH>
              <TH numeric>Batches</TH>
              <TH numeric>Quantity</TH>
            </THead>
            <tbody>
              {ageing.map((row) => (
                <TR key={row.bucket}>
                  <TD>
                    {row.bucket === 'expired' && row.qtyMilli > 0 ? (
                      <span className="font-medium text-danger">{row.label}</span>
                    ) : row.bucket === 'within7' && row.qtyMilli > 0 ? (
                      <span className="font-medium text-warning">{row.label}</span>
                    ) : (
                      <span className="text-content">{row.label}</span>
                    )}
                  </TD>
                  <TD numeric>{row.batchCount === 0 ? '—' : row.batchCount}</TD>
                  <TD numeric>
                    {row.qtyMilli === 0 ? '—' : quantity(makeQty(row.qtyMilli), '')}
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>
          <p className="-mt-6 mb-8 text-xs text-content-muted">
            Quantities across every product, so units are mixed. Stock with no date recorded is
            listed separately rather than as distant: unknown is not the same as far away.{' '}
            <a
              href={`/api/reports/expiry?to=${toBusinessDate()}`}
              className="font-medium text-accent hover:underline"
            >
              Download every batch
            </a>{' '}
            to see which ones.
          </p>
        </>
      )}

      <h2 className="mb-3 text-sm font-semibold text-content">Stock valuation</h2>
      <TableWrap className="mb-8">
        <THead>
          <TH>Product</TH>
          <TH>Category</TH>
          <TH numeric>On hand</TH>
          <TH numeric>Avg cost</TH>
          <TH numeric>Value at cost</TH>
          <TH numeric>Selling price</TH>
          <TH numeric>Value at retail</TH>
          <TH />
        </THead>
        <tbody>
          {valuation.rows.map((row) => (
            <TR key={row.productId}>
              <TD>
                <Link
                  href={`/inventory?product=${row.productId}`}
                  className="font-medium text-accent hover:underline"
                >
                  {row.productName}
                </Link>
                {row.sku && <span className="ml-2 text-xs text-content-subtle">{row.sku}</span>}
              </TD>
              <TD>
                <span className="text-content-muted">{row.categoryName ?? '—'}</span>
              </TD>
              <TD numeric>{quantity(row.qtyOnHand, row.unit)}</TD>
              <TD numeric>
                {row.qtyOnHand === 0 ? '—' : money(row.averageCost, { bare: true })}
              </TD>
              <TD numeric>{money(row.stockValue, { bare: true })}</TD>
              <TD numeric>{money(row.sellingPrice, { bare: true })}</TD>
              <TD numeric>{money(row.retailValue, { bare: true })}</TD>
              <TD>
                <div className="flex justify-end">
                  {row.outOfStock ? (
                    <Badge tone="danger">Out</Badge>
                  ) : row.lowStock ? (
                    <Badge tone="warning">Low</Badge>
                  ) : null}
                </div>
              </TD>
            </TR>
          ))}
          <TR className="bg-surface-sunken font-semibold">
            <TD>Total</TD>
            <TD />
            <TD />
            <TD />
            <TD numeric>{money(valuation.totalCostValue, { bare: true })}</TD>
            <TD />
            <TD numeric>{money(valuation.totalRetailValue, { bare: true })}</TD>
            <TD />
          </TR>
        </tbody>
      </TableWrap>

      <PeriodFilter basePath="/reports/inventory" active={preset} period={period} />

      <h2 className="mb-3 text-sm font-semibold text-content">
        Stock movement — {describePeriod(period, preset).toLowerCase()}
      </h2>
      {movement.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong bg-surface-raised px-6 py-8 text-center text-sm text-content-muted">
          No stock moved in this period.
        </p>
      ) : (
        <TableWrap>
          <THead>
            <TH>Product</TH>
            <TH numeric>In</TH>
            <TH numeric>Out</TH>
            <TH numeric>Net</TH>
            <TH numeric>Value in</TH>
            <TH numeric>Value out</TH>
            <TH numeric>On hand now</TH>
          </THead>
          <tbody>
            {movement.map((row) => (
              <TR key={row.productId}>
                <TD>
                  <span className="font-medium text-content">{row.productName}</span>
                </TD>
                <TD numeric>{row.qtyIn > 0 ? quantity(row.qtyIn, row.unit) : '—'}</TD>
                <TD numeric>{row.qtyOut > 0 ? quantity(row.qtyOut, row.unit) : '—'}</TD>
                <TD numeric>
                  <span className={row.netQty < 0 ? 'text-warning' : ''}>
                    {quantity(row.netQty, row.unit)}
                  </span>
                </TD>
                <TD numeric>{money(row.valueIn, { bare: true })}</TD>
                <TD numeric>{money(row.valueOut, { bare: true })}</TD>
                <TD numeric>{quantity(row.closingQty, row.unit)}</TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Stock is valued at what it actually cost, using weighted average — the same figure that
        appears as Inventory on the balance sheet.
      </p>
    </div>
  );
}
