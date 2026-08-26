import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  countIncomes,
  getFilteredIncomesSummary,
  listIncomes,
} from '@/services/cashbook.service';
import { listIncomeCategories, listPaymentAccounts } from '@/services/payment-account.service';
import {
  createIncomeCategoryAction,
  recordIncomeAction,
  voidIncomeAction,
} from '@/actions/cashbook.actions';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import {
  buildQuery,
  chipAmount,
  clampPage,
  describeDateRange,
  type ActiveFilter,
} from '@/lib/filters';
import { parseCashbookFilters, type SearchParams } from '@/lib/list-filters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RowVoidForm } from '@/components/shared/row-void-form';
import { Alert } from '@/components/ui/alert';
import { Card, EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { AddCategoryForm, CashbookForm } from '@/components/shared/cashbook-form';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Other income' };
export const dynamic = 'force-dynamic';

export default async function IncomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('income', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const { filters, range, preset, page: requestedPage, pageSize, carried } =
    parseCashbookFilters(params, today);

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const total = countIncomes(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const rows = listIncomes(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });

  const summary = getFilteredIncomesSummary(db, filters);

  const categories = listIncomeCategories(db);
  const accounts = listPaymentAccounts(db).map((account) => ({
    id: account.id,
    name: account.name,
    isDefault: account.isDefault,
  }));

  const sort = filters.sort ?? 'date';
  const direction = filters.direction ?? 'desc';

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
  if (filters.categoryAccountId !== undefined) {
    active.push({
      key: 'category',
      label: 'Category',
      value:
        categories.find((item) => item.id === filters.categoryAccountId)?.name ??
        String(filters.categoryAccountId),
    });
  }
  if (filters.paymentAccountId !== undefined) {
    active.push({
      key: 'account',
      label: 'Received into',
      value:
        accounts.find((item) => item.id === filters.paymentAccountId)?.name ??
        String(filters.paymentAccountId),
    });
  }
  if (filters.status !== undefined) {
    active.push({
      key: 'status',
      label: 'Status',
      value: filters.status === 'VOIDED' ? 'Voided' : 'Posted',
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

  const canCreate = can(user, 'income', 'create');
  const canVoid = can(user, 'income', 'void');
  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/income${buildQuery(carried)}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Other income"
        description="Money in that is not a product sale — commission, services, anything else."
        actions={
          <a href={exportHref} download>
            <Button variant="secondary" size="sm" type="button">
              Download CSV
            </Button>
          </a>
        }
      />

      {params.created === '1' && (
        <Alert tone="success" className="mb-4">
          Income recorded. It went into the account you chose, kept separate from sales.
        </Alert>
      )}
      {params.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Income voided. The original record was kept and a reversing entry posted.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Transactions"
          value={String(summary.count)}
          hint={describeDateRange(range, preset, today)}
        />
        <Stat label="Total received" value={money(summary.total, { currencyCode: currency })} />
        <Stat label="Average" value={money(summary.average, { currencyCode: currency })} />
      </div>

      <FilterBar
        basePath="/income"
        dateRange={{ preset, from: range.from, to: range.to }}
        active={active}
        quick={[
          {
            label: "Today's income",
            params: { period: 'today', from: null, to: null },
            match: { period: 'today' },
          },
          {
            label: 'Last month',
            params: { period: 'last-month', from: null, to: null },
            match: { period: 'last-month' },
          },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Description, reference or note',
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
            key: 'account',
            label: 'Received into',
            allLabel: 'Any account',
            options: accounts.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'status',
            label: 'Status',
            allLabel: 'All',
            options: [
              { value: 'POSTED', label: 'Posted' },
              { value: 'VOIDED', label: 'Voided' },
            ],
          },
          { kind: 'amount-range', minKey: 'min', maxKey: 'max', label: 'Amount', currency },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {rows.length === 0 ? (
            <EmptyState
              title={isFiltered ? 'No income matches these filters' : 'No other income yet'}
              description={
                isFiltered
                  ? 'Try widening the dates, or clear a filter to see more.'
                  : 'Use this for money that is not from selling stock, so it does not get mixed into your sales figures.'
              }
            />
          ) : (
            <>
              <TableWrap>
                <THead>
                  <TH>
                    <SortLink
                      basePath="/income"
                      values={carried}
                      column="date"
                      activeSort={sort}
                      activeDirection={direction}
                    >
                      Date
                    </SortLink>
                  </TH>
                  <TH>Description</TH>
                  <TH>
                    <SortLink
                      basePath="/income"
                      values={carried}
                      column="category"
                      activeSort={sort}
                      activeDirection={direction}
                      defaultDirection="asc"
                    >
                      Category
                    </SortLink>
                  </TH>
                  <TH>Received into</TH>
                  <TH numeric>
                    <SortLink
                      basePath="/income"
                      values={carried}
                      column="amount"
                      activeSort={sort}
                      activeDirection={direction}
                    >
                      Amount
                    </SortLink>
                  </TH>
                  <TH />
                </THead>
                <tbody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD>
                        <span className="whitespace-nowrap text-content-muted">
                          {formatDate(row.businessDate)}
                        </span>
                      </TD>
                      <TD>
                        <span className="font-medium text-content">{row.description}</span>
                        {row.reference && (
                          <span className="ml-2 text-xs text-content-subtle">{row.reference}</span>
                        )}
                      </TD>
                      <TD>
                        <span className="text-content-muted">{row.categoryName}</span>
                      </TD>
                      <TD>
                        <span className="text-content-muted">{row.paymentAccountName}</span>
                      </TD>
                      <TD numeric>
                        <span className={row.status === 'VOIDED' ? 'line-through opacity-60' : ''}>
                          {money(minor(row.amountMinor), { bare: true })}
                        </span>
                      </TD>
                      <TD>
                        {row.status === 'VOIDED' ? (
                          <Badge tone="danger">Voided</Badge>
                        ) : (
                          canVoid && (
                            <RowVoidForm
                              action={voidIncomeAction.bind(null, row.id)}
                              what={row.description}
                              placeholder="e.g. Entered twice"
                            />
                          )
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </TableWrap>

              <Pagination
                basePath="/income"
                values={carried}
                page={page}
                pageSize={pageSize}
                total={total}
                noun="entry"
                nounPlural="entries"
              />
            </>
          )}
        </div>

        <div>
          {canCreate ? (
            <>
              <h2 className="mb-3 text-sm font-semibold text-content">Record income</h2>
              <CashbookForm
                action={recordIncomeAction}
                categories={categories}
                accounts={accounts}
                today={today}
                currencyCode={currency}
                submitLabel="Record income"
                categoryLabel="Category"
                accountLabel="Received into"
                amountLabel="Amount"
                descriptionPlaceholder="e.g. Airtime commission"
                emptyCategoriesHint="Add a category first."
              />
              <div className="mt-3">
                <AddCategoryForm
                  action={createIncomeCategoryAction}
                  label="New income category"
                  placeholder="e.g. Table rental"
                />
              </div>
            </>
          ) : (
            <Card>
              <p className="text-sm text-content-muted">
                You do not have permission to record income.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
