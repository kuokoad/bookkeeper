import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getBalanceSheet } from '@/services/reporting/financial.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { ReportActions } from '@/components/shared/report-actions';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Balance sheet' };
export const dynamic = 'force-dynamic';

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asAt?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const asAt = params.asAt ?? toBusinessDate();
  const sheet = getBalanceSheet(db, asAt);
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Balance sheet"
        description={`As at ${formatDate(asAt)}`}
        actions={<ReportActions csvHref={`/api/reports/balance-sheet?asAt=${asAt}`} />}
      />

      {!sheet.balances && (
        <Alert tone="danger" title="This balance sheet does not balance" className="mb-4">
          Assets {money(sheet.totalAssets)} do not equal liabilities plus equity{' '}
          {money(sheet.totalLiabilitiesAndEquity)}. Difference {money(sheet.difference)}. This
          should be impossible — please report it.
        </Alert>
      )}

      <form action="/reports/balance-sheet" className="mb-4 flex flex-wrap items-end gap-2 no-print">
        <div>
          <label htmlFor="asAt" className="mb-1 block text-xs text-content-muted">
            As at
          </label>
          <input
            id="asAt"
            name="asAt"
            type="date"
            defaultValue={asAt}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
      </form>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="What you own" value={money(sheet.totalAssets)} />
        <Stat label="What you owe" value={money(sheet.totalLiabilities)} />
        <Stat
          label="Business worth"
          value={money(sheet.totalEquity)}
          tone={sheet.totalEquity < 0 ? 'danger' : 'success'}
        />
      </div>

      <div className="mb-2 text-sm font-semibold text-content">
        {settings?.businessName ?? 'Shop'} — Balance sheet as at {formatDate(asAt)}
      </div>

      <TableWrap>
        <THead>
          <TH>Item</TH>
          <TH numeric>Amount</TH>
        </THead>
        <tbody>
          {/*
            Dual headings: the plain wording is for the owner, the formal term
            for the accountant who also reads this. Neither audience should have
            to translate.
          */}
          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">What the business owns</span>
              <span className="ml-2 text-xs font-normal text-content-subtle">(Assets)</span>
            </TD>
            <TD />
          </TR>
          {sheet.cashAccounts.map((line) => (
            <TR key={line.accountId}>
              <TD>
                <span className="pl-4">{line.name}</span>
              </TD>
              <TD numeric>{money(line.amount, { bare: true })}</TD>
            </TR>
          ))}
          <TR>
            <TD>
              <span className="pl-4">Money customers owe you</span>
            </TD>
            <TD numeric>{money(sheet.receivables, { bare: true })}</TD>
          </TR>
          {sheet.supplierAdvances !== 0 && (
            <TR>
              <TD>
                <span className="pl-4">Paid to suppliers in advance</span>
              </TD>
              <TD numeric>{money(sheet.supplierAdvances, { bare: true })}</TD>
            </TR>
          )}
          <TR>
            <TD>
              <span className="pl-4">Stock on the shelf</span>
            </TD>
            <TD numeric>{money(sheet.inventory, { bare: true })}</TD>
          </TR>
          {sheet.otherAssets.map((line) => (
            <TR key={line.accountId}>
              <TD>
                <span className="pl-4">{line.name}</span>
              </TD>
              <TD numeric>{money(line.amount, { bare: true })}</TD>
            </TR>
          ))}
          <TR className="font-semibold">
            <TD>Total assets</TD>
            <TD numeric>{money(sheet.totalAssets, { bare: true })}</TD>
          </TR>

          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">What the business owes</span>
              <span className="ml-2 text-xs font-normal text-content-subtle">(Liabilities)</span>
            </TD>
            <TD />
          </TR>
          <TR>
            <TD>
              <span className="pl-4">Money you owe suppliers</span>
            </TD>
            <TD numeric>{money(sheet.payables, { bare: true })}</TD>
          </TR>
          {sheet.customerCredits !== 0 && (
            <TR>
              <TD>
                {/* Money already taken from customers for goods not yet
                    bought. It is owed back, so it belongs here and not
                    netted off what customers owe. */}
                <span className="pl-4">Customer credit balances</span>
              </TD>
              <TD numeric>{money(sheet.customerCredits, { bare: true })}</TD>
            </TR>
          )}
          {sheet.taxPayable !== 0 && (
            <TR>
              <TD>
                <span className="pl-4">Tax not yet paid</span>
              </TD>
              <TD numeric>{money(sheet.taxPayable, { bare: true })}</TD>
            </TR>
          )}
          {sheet.otherLiabilities.map((line) => (
            <TR key={line.accountId}>
              <TD>
                <span className="pl-4">{line.name}</span>
              </TD>
              <TD numeric>{money(line.amount, { bare: true })}</TD>
            </TR>
          ))}
          <TR className="font-semibold">
            <TD>Total liabilities</TD>
            <TD numeric>{money(sheet.totalLiabilities, { bare: true })}</TD>
          </TR>

          <TR className="bg-surface-sunken">
            <TD>
              <span className="font-semibold text-content">Your stake in the business</span>
              <span className="ml-2 text-xs font-normal text-content-subtle">(Equity)</span>
            </TD>
            <TD />
          </TR>
          <TR>
            <TD>
              <span className="pl-4">Money you put in</span>
            </TD>
            <TD numeric>{money(sheet.ownersCapital, { bare: true })}</TD>
          </TR>
          {sheet.drawings !== 0 && (
            <TR>
              <TD>
                <span className="pl-4 text-content-muted">Less: money you took out</span>
              </TD>
              <TD numeric>({money(sheet.drawings, { bare: true })})</TD>
            </TR>
          )}
          {sheet.openingBalanceEquity !== 0 && (
            <TR>
              <TD>
                <span className="pl-4">Opening balances</span>
              </TD>
              <TD numeric>{money(sheet.openingBalanceEquity, { bare: true })}</TD>
            </TR>
          )}
          <TR>
            <TD>
              <span className="pl-4">Profit kept in the business</span>
            </TD>
            <TD numeric>
              <span className={sheet.retainedEarnings < 0 ? 'text-danger' : ''}>
                {money(sheet.retainedEarnings, { bare: true })}
              </span>
            </TD>
          </TR>
          <TR className="font-semibold">
            <TD>Total your stake</TD>
            <TD numeric>{money(sheet.totalEquity, { bare: true })}</TD>
          </TR>

          <TR className="bg-accent-soft text-base font-semibold">
            <TD>Liabilities + your stake</TD>
            <TD numeric>{money(sheet.totalLiabilitiesAndEquity, { bare: true })}</TD>
          </TR>
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        {sheet.balances
          ? 'What the business owns exactly equals what it owes plus your stake in it. That is the check that the books are sound.'
          : 'WARNING: this statement does not balance.'}{' '}
        Profit is folded straight into your stake — there is no year-end closing step to run.
      </p>
    </div>
  );
}
