import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  countAccountMovements,
  getAccountStatement,
  getPaymentAccount,
  listAccountSourceTypes,
} from '@/services/payment-account.service';
import { formatDate, formatDateTime, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import {
  buildQuery,
  chipAmount,
  clampPage,
  describeDateRange,
  type ActiveFilter,
} from '@/lib/filters';
import { parseAccountFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

/** Where each movement came from, in words the owner uses. */
const SOURCE_LABELS: Record<string, string> = {
  SALE: 'Sale',
  SALE_RETURN: 'Customer return',
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Return to supplier',
  CUSTOMER_PAYMENT: 'Customer payment',
  SUPPLIER_PAYMENT: 'Paid supplier',
  EXPENSE: 'Expense',
  INCOME: 'Other income',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  RECONCILIATION: 'Reconciliation',
  OPENING_BALANCE: 'Opening balance',
  CAPITAL: 'Owner capital',
  DRAWINGS: 'Owner drawings',
  REVERSAL: 'Reversal',
  YEAR_END_CLOSE: 'Year-end close',
};

/** Where clicking a movement should take you. */
function sourceHref(sourceType: string, sourceId: number | null): string | null {
  if (sourceId === null) return null;
  switch (sourceType) {
    case 'SALE':
    case 'SALE_RETURN':
      return `/sales/${sourceId}`;
    case 'PURCHASE':
    case 'PURCHASE_RETURN':
      return `/purchases/${sourceId}`;
    case 'STOCK_ADJUSTMENT':
      return `/inventory/adjustments/${sourceId}`;
    default:
      return null;
  }
}

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await requirePageAccess('accounts', 'view');
  const { id } = await params;
  const query = await searchParams;

  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();

  let account;
  try {
    account = getPaymentAccount(db, accountId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const today = toBusinessDate();
  const { filters, range, preset, page: requestedPage, pageSize, carried } =
    parseAccountFilters(query, today);

  /*
    A statement, not a list of rows.

    Opening is read from the ledger — every entry dated before the window — so
    the running balance on the last row equals the closing figure and opening +
    in − out balances. Working backwards from today's balance instead would
    agree only when the window ends today; ask for last month and the figure
    would quietly carry this month's trading inside it.
  */
  const total = countAccountMovements(db, accountId, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const statement = getAccountStatement(db, accountId, {
    ...filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const sourceTypes = listAccountSourceTypes(db, accountId);

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
  if (filters.sourceType !== undefined) {
    active.push({
      key: 'type',
      label: 'Type',
      value: SOURCE_LABELS[filters.sourceType] ?? filters.sourceType,
    });
  }
  if (filters.flow !== undefined) {
    active.push({
      key: 'flow',
      label: 'Direction',
      value: filters.flow === 'in' ? 'Money in' : 'Money out',
    });
  }
  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    active.push({
      key: 'min',
      label: 'Amount',
      value:
        filters.minAmount !== undefined && filters.maxAmount !== undefined
          ? `${chipAmount(filters.minAmount)} – ${chipAmount(filters.maxAmount)}`
          : filters.minAmount !== undefined
            ? `over ${chipAmount(filters.minAmount)}`
            : `under ${chipAmount(filters.maxAmount!)}`,
      alsoClears: ['max'],
    });
  }
  if (preset !== 'month') {
    active.push({
      key: 'period',
      label: 'Period',
      value: describeDateRange(range, preset, today),
      alsoClears: ['from', 'to'],
    });
  }

  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/account${buildQuery({ ...carried, id: accountId })}`;

  /*
    Opening + in − out = closing holds for the DATE window. It does not hold
    once the owner also filters by type, direction or amount, because those
    hide movements that still happened — so the page says which figures are
    being shown rather than presenting an equation that no longer adds up.
  */
  const narrowedBeyondDates =
    filters.sourceType !== undefined ||
    filters.flow !== undefined ||
    filters.search !== undefined ||
    filters.minAmount !== undefined ||
    filters.maxAmount !== undefined;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={account.name}
        description={`${account.provider ? `${account.provider} · ` : ''}Ledger account ${account.glCode}`}
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            <Link href="/accounts">
              <Button variant="secondary" size="sm">
                All accounts
              </Button>
            </Link>
          </>
        }
      />

      {query.updated === '1' && (
        <Alert tone="success" className="mb-4">
          Account updated.
        </Alert>
      )}

      {account.balance < 0 && (
        <Alert tone="warning" title="This account is showing less than zero" className="mb-4">
          That normally means money went out of the wrong account, or something received was never
          recorded. The movements below show exactly how it got here.
        </Alert>
      )}

      <div className="mb-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          icon="accounts"
          label="Opening balance"
          value={money(statement.opening, { bare: true })}
          hint={`Before ${formatDate(range.from)}`}
          tone={statement.opening < 0 ? 'danger' : 'default'}
        />
        <Stat icon="income" label="Money in" value={money(statement.moneyIn, { bare: true })} tone="success" />
        <Stat icon="expenses" label="Money out" value={money(statement.moneyOut, { bare: true })} tone="warning" />
        <Stat
          icon="accounts"
          label="Closing balance"
          value={money(statement.closing, { bare: true })}
          hint={`At ${formatDate(range.to)}`}
          tone={statement.closing < 0 ? 'danger' : 'default'}
        />
        <Stat
          icon="accounts"
          label="Balance now"
          value={money(account.balance, { currencyCode: currency })}
          tone={account.balance < 0 ? 'danger' : 'default'}
        />
      </div>

      <p className="mb-6 text-xs text-content-subtle">
        {narrowedBeyondDates
          ? 'Money in and money out cover only the movements matching these filters, so they will not bridge the opening and closing balances. Clear the filters other than the dates to see the full period.'
          : `Opening ${money(statement.opening, { bare: true })} + in ${money(
              statement.moneyIn,
              { bare: true },
            )} − out ${money(statement.moneyOut, { bare: true })} = closing ${money(
              statement.closing,
              { bare: true },
            )}.`}
      </p>

      <h2 className="mb-3 text-sm font-semibold text-content">Movements</h2>

      <FilterBar
        basePath={`/accounts/${accountId}`}
        dateRange={{ preset, from: range.from, to: range.to }}
        active={active}
        quick={[
          {
            label: 'This month',
            params: { period: 'month', from: null, to: null },
            match: { period: 'month' },
          },
          { label: 'Money in', params: { flow: 'in' }, match: { flow: 'in' } },
          { label: 'Money out', params: { flow: 'out' }, match: { flow: 'out' } },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Entry number, memo or description',
            wide: true,
          },
          {
            kind: 'select',
            key: 'type',
            label: 'Transaction type',
            allLabel: 'All types',
            options: sourceTypes.map((type) => ({
              value: type,
              label: SOURCE_LABELS[type] ?? type,
            })),
          },
          {
            kind: 'select',
            key: 'flow',
            label: 'Direction',
            allLabel: 'In and out',
            options: [
              { value: 'in', label: 'Money in' },
              { value: 'out', label: 'Money out' },
            ],
          },
          { kind: 'amount-range', minKey: 'min', maxKey: 'max', label: 'Amount', currency },
        ]}
      />

      {statement.movements.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No movements match these filters' : 'Nothing has moved through this account yet'}
          description={
            isFiltered
              ? 'Try widening the dates, or clear a filter to see more.'
              : 'Sales, purchases, expenses and payments that use this account will appear here with a running balance.'
          }
        />
      ) : (
        <>
          <TableWrap>
            <THead>
              <TH>Date</TH>
              <TH>What happened</TH>
              <TH>Reference</TH>
              <TH numeric>In</TH>
              <TH numeric>Out</TH>
              <TH numeric>Balance</TH>
            </THead>
            <tbody>
              {statement.movements.map((movement) => {
                const href = sourceHref(movement.sourceType, movement.sourceId);
                return (
                  <TR key={`${movement.entryId}-${movement.entryNo}-${movement.runningBalance}`}>
                    <TD>
                      <span className="whitespace-nowrap text-content-muted">
                        {formatDate(movement.entryDate)}
                      </span>
                      <span className="block text-xs text-content-subtle">
                        {formatDateTime(movement.occurredAt).split(', ')[1] ?? ''}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={movement.inMinor > 0 ? 'success' : 'warning'}>
                        {SOURCE_LABELS[movement.sourceType] ?? movement.sourceType}
                      </Badge>
                      <span className="mt-0.5 block text-xs text-content-muted">
                        {movement.description ?? movement.memo ?? ''}
                      </span>
                    </TD>
                    <TD>
                      {href ? (
                        <Link
                          href={href}
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          {movement.entryNo}
                        </Link>
                      ) : (
                        <span className="text-xs text-content-subtle">{movement.entryNo}</span>
                      )}
                    </TD>
                    <TD numeric>
                      {movement.inMinor > 0 ? money(minor(movement.inMinor), { bare: true }) : '—'}
                    </TD>
                    <TD numeric>
                      {movement.outMinor > 0 ? money(minor(movement.outMinor), { bare: true }) : '—'}
                    </TD>
                    <TD numeric>
                      <span
                        className={
                          movement.runningBalance < 0 ? 'font-medium text-danger' : 'font-medium'
                        }
                      >
                        {money(minor(movement.runningBalance), { bare: true })}
                      </span>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </TableWrap>

          <Pagination
            basePath={`/accounts/${accountId}`}
            values={carried}
            page={page}
            pageSize={pageSize}
            total={total}
            noun="movement"
          />
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        This is the full answer to &ldquo;why is the balance{' '}
        {money(account.balance, { currencyCode: currency })}?&rdquo; — every line that moved money
        through this account, newest first, with the balance after each one. The column runs on from
        the opening balance, so it carries across pages and never restarts at zero when a date
        filter is applied. Everything here reads the ledger; nothing on this page can change a
        balance.
      </p>
    </div>
  );
}
