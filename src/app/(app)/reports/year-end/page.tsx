import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  availableFinancialYears,
  getYearEndPack,
  type YearEndPack,
} from '@/services/reporting/year-end.service';
import { MONTH_NAMES } from '@/services/settings.service';
import { moneyAccounting } from '@/lib/format';
import { formatDate, toBusinessDate } from '@/lib/format';
import { minor, negate, type Minor } from '@/domain/money';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';

export const metadata: Metadata = { title: 'Year-end pack' };
export const dynamic = 'force-dynamic';

/**
 * The statements an accountant is given at the end of the year.
 *
 * Every figure is drawn from the same reporting services the shop uses all
 * year — nothing here recomputes anything, because a pack that disagreed with
 * the on-screen Profit & Loss would give no way of telling which was right.
 *
 * It is written to be printed. The controls carry `no-print`, so what comes out
 * of the printer is the statements and nothing else.
 */

function Row({
  label,
  value,
  previous,
  currency,
  bold,
  indent,
  rule,
}: {
  label: string;
  value: Minor;
  previous?: Minor;
  currency: string;
  bold?: boolean;
  indent?: boolean;
  rule?: boolean;
}) {
  return (
    <tr className={rule ? 'border-t border-line-strong' : undefined}>
      <td
        className={`py-1.5 pr-4 ${indent ? 'pl-4' : ''} ${bold ? 'font-semibold text-content' : 'text-content-muted'}`}
      >
        {label}
      </td>
      <td className={`tabular py-1.5 text-right ${bold ? 'font-semibold text-content' : 'text-content'}`}>
        {moneyAccounting(value, { currencyCode: currency })}
      </td>
      {previous !== undefined && (
        <td className="tabular py-1.5 pl-6 text-right text-content-muted">
          {moneyAccounting(previous, { currencyCode: currency })}
        </td>
      )}
    </tr>
  );
}

function Statement({
  title,
  note,
  headers,
  children,
}: {
  title: string;
  note?: string;
  headers: string[];
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8 break-inside-avoid">
      <h2 className="mb-1 text-base font-semibold text-content">{title}</h2>
      {note && <p className="mb-2 text-xs text-content-muted">{note}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-strong text-xs uppercase tracking-wide text-content-subtle">
            <th className="py-1.5 text-left font-medium">{headers[0]}</th>
            {headers.slice(1).map((header) => (
              <th
                key={header}
                className={`py-1.5 text-right font-medium ${header === headers[2] ? 'pl-6' : ''}`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

export default async function YearEndPackPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const { year: requested } = await searchParams;

  const years = availableFinancialYears(db);
  const chosen =
    years.find((year) => String(year.startYear) === requested) ?? (years[0] as (typeof years)[number]);

  const pack: YearEndPack = getYearEndPack(db, chosen.startYear);
  const c = pack.shop.currencyCode;
  const { profitAndLoss: pl, previousProfitAndLoss: previousPl, balanceSheet: bs } = pack;
  const previousBs = pack.previousBalanceSheet;

  const columns = [pack.year.label, pack.previous.label];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="no-print">
        <PageHeader
          title="Year-end pack"
          description="The statements your accountant needs, for one financial year."
          actions={
            <div className="flex flex-wrap gap-2">
              <a href={`/api/reports/year-end?year=${pack.year.startYear}`}>
                <Button variant="secondary" size="sm">
                  Download CSV
                </Button>
              </a>
              <Link href="/reports">
                <Button variant="secondary" size="sm">
                  All reports
                </Button>
              </Link>
            </div>
          }
        />

        {years.length > 1 && (
          <form action="/reports/year-end" className="mb-4 flex items-end gap-2">
            <div>
              <label htmlFor="year" className="mb-1 block text-xs text-content-muted">
                Financial year
              </label>
              <select
                id="year"
                name="year"
                defaultValue={String(pack.year.startYear)}
                className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
              >
                {years.map((year) => (
                  <option key={year.startYear} value={year.startYear}>
                    {year.label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm" variant="secondary">
              Show
            </Button>
          </form>
        )}

        {pack.isProvisional && (
          <Alert tone="warning" title="This year has not finished" className="mb-4">
            These are draft figures up to today, not final accounts. The year ends{' '}
            {formatDate(pack.year.end)}.
          </Alert>
        )}

        {!pack.integrity.trialBalanced && (
          <Alert tone="danger" title="The books do not balance" className="mb-4">
            Do not give this to an accountant until it is resolved. Debits and credits differ by{' '}
            {moneyAccounting(pack.integrity.difference, { currencyCode: c })}.
          </Alert>
        )}

        {!pack.isLocked && !pack.isProvisional && (
          <Alert tone="info" className="mb-4">
            This year is not closed, so entries dated inside it can still be added or changed. To
            fix the figures, set the books lock to {formatDate(pack.year.end)} under Accounting.
          </Alert>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The pack itself, from here down.                                  */}
      {/* ---------------------------------------------------------------- */}

      <header className="mb-8 border-b-2 border-line-strong pb-4">
        <h1 className="text-xl font-semibold text-content">{pack.shop.name}</h1>
        {pack.shop.address && <p className="text-sm text-content-muted">{pack.shop.address}</p>}
        <p className="text-sm text-content-muted">
          {[pack.shop.phone, pack.shop.email].filter(Boolean).join(' · ')}
        </p>
        <p className="mt-3 text-sm font-medium text-content">
          Financial statements for the year {pack.year.label}
        </p>
        <p className="text-sm text-content-muted">
          {formatDate(pack.year.start)} to {formatDate(pack.year.end)} · all figures in {c}
        </p>
        <p className="mt-1 text-xs text-content-subtle">
          Prepared {formatDate(toBusinessDate())} from {pack.entryCount}{' '}
          journal entries dated in the year
          {pack.isProvisional ? ' · PROVISIONAL, the year has not finished' : ''}
        </p>
      </header>

      <Statement
        title="Profit and Loss"
        note={`For the year ended ${formatDate(pack.year.end)}`}
        headers={['', ...columns]}
      >
        <Row label="Sales" value={pl.salesRevenue} previous={previousPl.salesRevenue} currency={c} />
        {pl.salesDiscounts !== 0 && (
          <Row label="Less discounts" value={negate(pl.salesDiscounts)} previous={negate(previousPl.salesDiscounts)} currency={c} indent />
        )}
        {pl.salesReturns !== 0 && (
          <Row label="Less returns" value={negate(pl.salesReturns)} previous={negate(previousPl.salesReturns)} currency={c} indent />
        )}
        <Row label="Net sales" value={pl.netSales} previous={previousPl.netSales} currency={c} rule />
        <Row label="Cost of goods sold" value={negate(pl.costOfGoodsSold)} previous={negate(previousPl.costOfGoodsSold)} currency={c} />
        <Row label="Gross profit" value={pl.grossProfit} previous={previousPl.grossProfit} currency={c} bold rule />

        {pl.totalOtherIncome !== 0 && (
          <Row label="Other income" value={pl.totalOtherIncome} previous={previousPl.totalOtherIncome} currency={c} />
        )}

        {pl.expenses.map((line) => {
          const before = previousPl.expenses.find((other) => other.accountId === line.accountId);
          return (
            <Row
              key={line.accountId}
              label={line.name}
              value={negate(line.amount)}
              previous={negate(before?.amount ?? minor(0))}
              currency={c}
              indent
            />
          );
        })}
        <Row label="Total expenses" value={negate(pl.totalExpenses)} previous={negate(previousPl.totalExpenses)} currency={c} rule />
        <Row label="Net profit for the year" value={pl.netProfit} previous={previousPl.netProfit} currency={c} bold rule />
      </Statement>

      <Statement
        title="Balance Sheet"
        note={`As at ${formatDate(pack.year.end)}`}
        headers={['', ...columns]}
      >
        <Row label="Cash, mobile money and bank" value={bs.totalCash} previous={previousBs.totalCash} currency={c} />
        <Row label="Owed by customers" value={bs.receivables} previous={previousBs.receivables} currency={c} />
        <Row label="Stock on hand" value={bs.inventory} previous={previousBs.inventory} currency={c} />
        {bs.otherAssets.map((line) => (
          <Row key={line.accountId} label={line.name} value={line.amount} currency={c} indent />
        ))}
        <Row label="Total assets" value={bs.totalAssets} previous={previousBs.totalAssets} currency={c} bold rule />

        <Row label="Owed to suppliers" value={bs.payables} previous={previousBs.payables} currency={c} />
        {bs.taxPayable !== 0 && (
          <Row label="Tax payable" value={bs.taxPayable} previous={previousBs.taxPayable} currency={c} />
        )}
        <Row label="Total liabilities" value={bs.totalLiabilities} previous={previousBs.totalLiabilities} currency={c} bold rule />

        <Row label="Owner's stake" value={bs.totalEquity} previous={previousBs.totalEquity} currency={c} bold />
        <Row
          label="Total liabilities and owner's stake"
          value={bs.totalLiabilitiesAndEquity}
          previous={previousBs.totalLiabilitiesAndEquity}
          currency={c}
          bold
          rule
        />
      </Statement>

      <Statement
        title="Movement in the Owner's Stake"
        note="What the year did to the owner's capital"
        headers={['', pack.year.label]}
      >
        <Row label={`Balance at ${formatDate(pack.previous.end)}`} value={pack.equity.openingEquity} currency={c} />
        <Row label="Capital introduced" value={pack.equity.capitalIntroduced} currency={c} indent />
        <Row label="Drawings" value={negate(pack.equity.drawings)} currency={c} indent />
        {pack.equity.openingBalancesRecognised !== 0 && (
          <Row
            label="Opening balances brought in"
            value={pack.equity.openingBalancesRecognised}
            currency={c}
            indent
          />
        )}
        <Row label="Profit for the year" value={pack.equity.profitForYear} currency={c} indent />
        <Row label={`Balance at ${formatDate(pack.year.end)}`} value={pack.equity.closingEquity} currency={c} bold rule />
      </Statement>

      <Statement
        title="Cash Flow"
        note={`Money in and out over the year ended ${formatDate(pack.year.end)}`}
        headers={['', 'In', 'Out']}
      >
        <tr>
          <td className="py-1.5 pr-4 text-content-muted">
            Balance at {formatDate(pack.previous.end)}
          </td>
          <td className="tabular py-1.5 text-right text-content">
            {moneyAccounting(pack.cashFlow.openingBalance, { currencyCode: c })}
          </td>
          <td />
        </tr>
        {pack.cashFlow.lines.map((flow) => (
          <tr key={flow.sourceType}>
            <td className="py-1.5 pl-4 pr-4 text-content-muted">{flow.label}</td>
            <td className="tabular py-1.5 text-right text-content">
              {flow.inMinor === 0 ? '' : moneyAccounting(flow.inMinor, { currencyCode: c })}
            </td>
            <td className="tabular py-1.5 pl-6 text-right text-content">
              {flow.outMinor === 0 ? '' : moneyAccounting(flow.outMinor, { currencyCode: c })}
            </td>
          </tr>
        ))}
        <tr className="border-t border-line-strong font-semibold">
          <td className="py-1.5 pr-4 text-content">Total</td>
          <td className="tabular py-1.5 text-right text-content">
            {moneyAccounting(pack.cashFlow.totalIn, { currencyCode: c })}
          </td>
          <td className="tabular py-1.5 pl-6 text-right text-content">
            {moneyAccounting(pack.cashFlow.totalOut, { currencyCode: c })}
          </td>
        </tr>
        <tr>
          <td className="py-1.5 pr-4 font-semibold text-content">
            Balance at {formatDate(pack.year.end)}
          </td>
          <td className="tabular py-1.5 text-right font-semibold text-content">
            {moneyAccounting(pack.cashFlow.closingBalance, { currencyCode: c })}
          </td>
          <td />
        </tr>
      </Statement>

      {pack.receivables.length > 0 && (
        <Statement
          title="Owed by Customers"
          note={`Outstanding at ${formatDate(pack.year.end)}, by how long it has been owed`}
          headers={['Customer', 'Over 90 days', 'Total']}
        >
          {pack.receivables.map((row) => (
            <tr key={row.partyId}>
              <td className="py-1 pr-4 text-content-muted">{row.partyName}</td>
              <td className="tabular py-1 text-right text-content">
                {row.over90 === 0 ? '' : moneyAccounting(row.over90, { currencyCode: c })}
              </td>
              <td className="tabular py-1 pl-6 text-right text-content">
                {moneyAccounting(row.total, { currencyCode: c })}
              </td>
            </tr>
          ))}
          <tr className="border-t border-line-strong font-semibold">
            <td className="py-1.5 pr-4 text-content">Total owed to the shop</td>
            <td />
            <td className="tabular py-1.5 pl-6 text-right text-content">
              {moneyAccounting(bs.receivables, { currencyCode: c })}
            </td>
          </tr>
        </Statement>
      )}

      {pack.payables.length > 0 && (
        <Statement
          title="Owed to Suppliers"
          note={`Outstanding at ${formatDate(pack.year.end)}, by how long it has been owed`}
          headers={['Supplier', 'Over 90 days', 'Total']}
        >
          {pack.payables.map((row) => (
            <tr key={row.partyId}>
              <td className="py-1 pr-4 text-content-muted">{row.partyName}</td>
              <td className="tabular py-1 text-right text-content">
                {row.over90 === 0 ? '' : moneyAccounting(row.over90, { currencyCode: c })}
              </td>
              <td className="tabular py-1 pl-6 text-right text-content">
                {moneyAccounting(row.total, { currencyCode: c })}
              </td>
            </tr>
          ))}
          <tr className="border-t border-line-strong font-semibold">
            <td className="py-1.5 pr-4 text-content">Total owed by the shop</td>
            <td />
            <td className="tabular py-1.5 pl-6 text-right text-content">
              {moneyAccounting(bs.payables, { currencyCode: c })}
            </td>
          </tr>
        </Statement>
      )}

      <Statement title="Trial Balance" note={`As at ${formatDate(pack.year.end)}`} headers={['Account', 'Debit', 'Credit']}>
        {pack.trialBalance.lines.map((row) => (
          <tr key={row.accountId}>
            <td className="py-1 pr-4 text-content-muted">
              {row.code} {row.name}
            </td>
            <td className="tabular py-1 text-right text-content">
              {row.totalDebit === 0 ? '' : moneyAccounting(row.totalDebit, { currencyCode: c })}
            </td>
            <td className="tabular py-1 pl-6 text-right text-content">
              {row.totalCredit === 0 ? '' : moneyAccounting(row.totalCredit, { currencyCode: c })}
            </td>
          </tr>
        ))}
        <tr className="border-t border-line-strong font-semibold">
          <td className="py-1.5 pr-4 text-content">Total</td>
          <td className="tabular py-1.5 text-right text-content">
            {moneyAccounting(pack.trialBalance.totalDebit, { currencyCode: c })}
          </td>
          <td className="tabular py-1.5 pl-6 text-right text-content">
            {moneyAccounting(pack.trialBalance.totalCredit, { currencyCode: c })}
          </td>
        </tr>
      </Statement>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-2 text-base font-semibold text-content">Notes to the statements</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-content-muted">
          <li>
            <span className="font-medium text-content">Basis of preparation.</span> These statements
            are prepared from a double-entry ledger. Every transaction is recorded as balanced
            debits and credits, and no balance is stored — each figure above is computed from the
            underlying journal lines, which can be inspected for any amount shown.
          </li>
          <li>
            <span className="font-medium text-content">Stock.</span> Valued at weighted average
            cost. Cost of goods sold is the cost recorded at the time of each sale, not a
            recalculation at the year end.
          </li>
          <li>
            <span className="font-medium text-content">Credit sales and purchases.</span> Recorded
            when the sale or purchase happens, not when the money moves. Amounts still outstanding
            appear as owed by customers and owed to suppliers.
          </li>
          <li>
            <span className="font-medium text-content">No closing entries.</span> Revenue and
            expense accounts are not zeroed at the year end. All-time profit is carried within the
            owner&apos;s stake, which is why the Trial Balance above shows cumulative figures while
            the Profit and Loss covers this year only. The Movement in the Owner&apos;s Stake
            reconciles the two.
          </li>
          <li>
            <span className="font-medium text-content">Corrections.</span> Nothing already recorded
            is edited or deleted. A correction is posted as a dated reversing entry, so the original
            and its reversal both remain visible.
          </li>
          {pack.booksLockedBefore && (
            <li>
              <span className="font-medium text-content">Period closed.</span> Entries dated on or
              before {formatDate(pack.booksLockedBefore)} are refused by the system.
            </li>
          )}
        </ol>
      </section>

      <section className="break-inside-avoid border-t border-line pt-4">
        <h2 className="mb-2 text-sm font-semibold text-content">Checks performed</h2>
        <ul className="space-y-1 text-sm text-content-muted">
          <li>
            Trial balance {pack.integrity.trialBalanced ? 'balances' : 'DOES NOT BALANCE'} — debits{' '}
            {moneyAccounting(pack.integrity.totalDebit, { currencyCode: c })}, credits{' '}
            {moneyAccounting(pack.integrity.totalCredit, { currencyCode: c })}
          </li>
          <li>Balance sheet {bs.balances ? 'balances' : 'DOES NOT BALANCE'}</li>
          <li>
            Owed by customers {pack.integrity.receivablesMatch ? 'agrees' : 'DOES NOT AGREE'} with
            the customer records
          </li>
          <li>
            Owed to suppliers {pack.integrity.payablesMatch ? 'agrees' : 'DOES NOT AGREE'} with the
            supplier records
          </li>
          <li>
            Owner&apos;s stake {pack.equity.reconciles ? 'reconciles' : 'DOES NOT RECONCILE'} from
            opening to closing
          </li>
          <li>
            Cash flow {pack.cashFlow.reconciles ? 'reconciles' : 'DOES NOT RECONCILE'} — opening plus
            movement equals closing
          </li>
        </ul>
      </section>

      <p className="mt-6 text-xs text-content-subtle">
        Financial year starting in {MONTH_NAMES[Number(pack.year.start.slice(5, 7)) - 1]}. Change it
        under Settings.
      </p>
    </div>
  );
}
