import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getProfitAndLoss } from '@/services/reporting/financial.service';
import { money, toBusinessDate } from '@/lib/format';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod, PeriodFilter, resolvePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';

export const metadata: Metadata = { title: 'Profit & Loss' };
export const dynamic = 'force-dynamic';

function percent(bp: number | null): string {
  return bp === null ? '—' : `${(bp / 100).toFixed(1)}%`;
}

export default async function ProfitAndLossPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const { period, preset } = resolvePeriod(params.period, params.from, params.to, toBusinessDate());
  const pl = getProfitAndLoss(db, period);

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const csvHref = `/api/reports/profit-and-loss?from=${period.from}&to=${period.to}`;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Profit & Loss"
        description={describePeriod(period, preset)}
        actions={<ReportActions csvHref={csvHref} />}
      />

      <PeriodFilter basePath="/reports/profit-and-loss" active={preset} period={period} />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Net sales" value={money(pl.netSales)} />
        <Stat
          label="Gross profit"
          value={money(pl.grossProfit)}
          hint={`Margin ${percent(pl.grossMarginBp)}`}
          tone={pl.grossProfit < 0 ? 'danger' : 'default'}
        />
        <Stat
          label="Net profit"
          value={money(pl.netProfit)}
          hint={`Margin ${percent(pl.netMarginBp)}`}
          tone={pl.netProfit < 0 ? 'danger' : 'success'}
        />
      </div>

      <div className="mb-2 text-sm font-semibold text-content">
        {settings?.businessName ?? 'Shop'} — Profit &amp; Loss
      </div>

      <TableWrap>
        <THead>
          <TH>Item</TH>
          <TH numeric>Amount</TH>
        </THead>
        <tbody>
          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">Revenue</span>
            </TD>
            <TD />
          </TR>
          <TR>
            <TD>
              <span className="pl-4">Sales</span>
            </TD>
            <TD numeric>{money(pl.salesRevenue, { bare: true })}</TD>
          </TR>
          {pl.salesDiscounts > 0 && (
            <TR>
              <TD>
                <span className="pl-4 text-content-muted">Less: discounts given</span>
              </TD>
              <TD numeric>({money(pl.salesDiscounts, { bare: true })})</TD>
            </TR>
          )}
          {pl.salesReturns > 0 && (
            <TR>
              <TD>
                <span className="pl-4 text-content-muted">Less: goods returned</span>
              </TD>
              <TD numeric>({money(pl.salesReturns, { bare: true })})</TD>
            </TR>
          )}
          <TR className="font-medium">
            <TD>
              <span className="pl-4">Net sales</span>
            </TD>
            <TD numeric>{money(pl.netSales, { bare: true })}</TD>
          </TR>

          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">Cost of goods sold</span>
            </TD>
            <TD numeric>({money(pl.costOfGoodsSold, { bare: true })})</TD>
          </TR>

          <TR className="bg-accent-soft font-semibold">
            <TD>Gross profit</TD>
            <TD numeric>{money(pl.grossProfit, { bare: true })}</TD>
          </TR>

          {pl.otherIncome.length > 0 && (
            <>
              <TR className="bg-surface-sunken">
                <TD>
                  <span className="font-semibold text-content">Other income</span>
                </TD>
                <TD />
              </TR>
              {pl.otherIncome.map((line) => (
                <TR key={line.accountId}>
                  <TD>
                    <span className="pl-4">{line.name}</span>
                  </TD>
                  <TD numeric>{money(line.amount, { bare: true })}</TD>
                </TR>
              ))}
              <TR className="font-medium">
                <TD>
                  <span className="pl-4">Total other income</span>
                </TD>
                <TD numeric>{money(pl.totalOtherIncome, { bare: true })}</TD>
              </TR>
            </>
          )}

          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">Running costs</span>
            </TD>
            <TD />
          </TR>
          {pl.expenses.length === 0 ? (
            <TR>
              <TD>
                <span className="pl-4 text-content-muted">No costs recorded in this period</span>
              </TD>
              <TD numeric>—</TD>
            </TR>
          ) : (
            pl.expenses.map((line) => (
              <TR key={line.accountId}>
                <TD>
                  <span className="pl-4">{line.name}</span>
                </TD>
                <TD numeric>{money(line.amount, { bare: true })}</TD>
              </TR>
            ))
          )}
          <TR className="font-medium">
            <TD>
              <span className="pl-4">Total running costs</span>
            </TD>
            <TD numeric>({money(pl.totalExpenses, { bare: true })})</TD>
          </TR>

          <TR className="bg-accent-soft text-base font-semibold">
            <TD>Net profit</TD>
            <TD numeric>
              <span className={pl.netProfit < 0 ? 'text-danger' : ''}>
                {money(pl.netProfit, { bare: true })}
              </span>
            </TD>
          </TR>
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        Cost of goods sold is what the items actually cost when they were sold, taken from the stock
        ledger — not from today&rsquo;s prices. Money the owner takes out is not counted here,
        because it is not a cost of running the shop.
      </p>
    </div>
  );
}
