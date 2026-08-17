import type { Metadata } from 'next';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getCashFlow } from '@/services/reporting/financial.service';
import { money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod, PeriodFilter, resolvePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';

export const metadata: Metadata = { title: 'Cash flow' };
export const dynamic = 'force-dynamic';

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const { period, preset } = resolvePeriod(params.period, params.from, params.to, toBusinessDate());
  const flow = getCashFlow(db, period);

  const moneyIn = flow.lines.filter((line) => line.inMinor > 0);
  const moneyOut = flow.lines.filter((line) => line.outMinor > 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Cash flow"
        description={describePeriod(period, preset)}
        actions={
          <ReportActions csvHref={`/api/reports/cash-flow?from=${period.from}&to=${period.to}`} />
        }
      />

      <PeriodFilter basePath="/reports/cash-flow" active={preset} period={period} />

      {!flow.reconciles && (
        <Alert tone="danger" title="Cash flow does not reconcile" className="mb-4">
          Opening plus movement does not equal closing. Please report this.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Started with" value={money(flow.openingBalance)} />
        <Stat label="Money in" value={money(flow.totalIn)} tone="success" />
        <Stat label="Money out" value={money(flow.totalOut)} tone="warning" />
        <Stat
          label="Ended with"
          value={money(flow.closingBalance)}
          tone={flow.closingBalance < 0 ? 'danger' : 'default'}
        />
      </div>

      <TableWrap className="mb-6">
        <THead>
          <TH>Where it came from / went</TH>
          <TH numeric>In</TH>
          <TH numeric>Out</TH>
          <TH numeric>Net</TH>
        </THead>
        <tbody>
          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">Opening balance</span>
            </TD>
            <TD />
            <TD />
            <TD numeric>{money(flow.openingBalance, { bare: true })}</TD>
          </TR>

          {moneyIn.length > 0 && (
            <TR className="bg-surface-sunken">
              <TD>
                <span className="font-semibold text-content">Money in</span>
              </TD>
              <TD />
              <TD />
              <TD />
            </TR>
          )}
          {moneyIn.map((line) => (
            <TR key={`in-${line.sourceType}`}>
              <TD>
                <span className="pl-4">{line.label}</span>
              </TD>
              <TD numeric>{money(line.inMinor, { bare: true })}</TD>
              <TD numeric>{line.outMinor > 0 ? money(line.outMinor, { bare: true }) : '—'}</TD>
              <TD numeric>{money(line.net, { bare: true })}</TD>
            </TR>
          ))}

          {moneyOut.length > 0 && (
            <TR className="bg-surface-sunken">
              <TD>
                <span className="font-semibold text-content">Money out</span>
              </TD>
              <TD />
              <TD />
              <TD />
            </TR>
          )}
          {moneyOut.map((line) => (
            <TR key={`out-${line.sourceType}`}>
              <TD>
                <span className="pl-4">{line.label}</span>
              </TD>
              <TD numeric>{line.inMinor > 0 ? money(line.inMinor, { bare: true }) : '—'}</TD>
              <TD numeric>{money(line.outMinor, { bare: true })}</TD>
              <TD numeric>{money(line.net, { bare: true })}</TD>
            </TR>
          ))}

          {flow.lines.length === 0 && (
            <TR>
              <TD>
                <span className="text-content-muted">No money moved in this period</span>
              </TD>
              <TD numeric>—</TD>
              <TD numeric>—</TD>
              <TD numeric>—</TD>
            </TR>
          )}

          <TR className="bg-accent-soft text-base font-semibold">
            <TD>Closing balance</TD>
            <TD numeric>{money(flow.totalIn, { bare: true })}</TD>
            <TD numeric>{money(flow.totalOut, { bare: true })}</TD>
            <TD numeric>{money(flow.closingBalance, { bare: true })}</TD>
          </TR>
        </tbody>
      </TableWrap>

      <h2 className="mb-3 text-sm font-semibold text-content">By account</h2>
      <TableWrap>
        <THead>
          <TH>Account</TH>
          <TH numeric>Opening</TH>
          <TH numeric>In</TH>
          <TH numeric>Out</TH>
          <TH numeric>Closing</TH>
        </THead>
        <tbody>
          {flow.byAccount.map((account) => (
            <TR key={account.id}>
              <TD>
                <span className="font-medium text-content">{account.name}</span>
              </TD>
              <TD numeric>{money(account.opening, { bare: true })}</TD>
              <TD numeric>{money(account.in, { bare: true })}</TD>
              <TD numeric>{money(account.out, { bare: true })}</TD>
              <TD numeric>
                <span className={account.closing < 0 ? 'font-medium text-danger' : 'font-medium'}>
                  {money(account.closing, { bare: true })}
                </span>
              </TD>
            </TR>
          ))}
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        This is money actually moving, not profit. A sale on credit shows nothing here until the
        customer pays — which is exactly why a profitable shop can still run out of cash.
      </p>
    </div>
  );
}
