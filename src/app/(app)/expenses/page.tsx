import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  countExpenses,
  getFilteredExpensesByCategory,
  getFilteredExpensesSummary,
  listExpenses,
} from '@/services/cashbook.service';
import { listExpenseCategories, listPaymentAccounts } from '@/services/payment-account.service';
import { listUsers } from '@/services/user.service';
import {
  createExpenseCategoryAction,
  recordExpenseAction,
  voidExpenseAction,
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
import { RowVoidForm } from '@/components/shared/row-void-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { AddCategoryForm, CashbookForm } from '@/components/shared/cashbook-form';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('expenses', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const { filters, range, preset, page: requestedPage, pageSize, carried } =
    parseCashbookFilters(params, today);

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const total = countExpenses(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const rows = listExpenses(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });

  // Count, total and average for exactly what the filter selects.
  const summary = getFilteredExpensesSummary(db, filters);
  const byCategory = getFilteredExpensesByCategory(db, filters);

  const categories = listExpenseCategories(db);
  const accounts = listPaymentAccounts(db).map((account) => ({
    id: account.id,
    name: account.name,
    isDefault: account.isDefault,
  }));
  const staff = listUsers(db);

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
      label: 'Paid from',
      value:
        accounts.find((item) => item.id === filters.paymentAccountId)?.name ??
        String(filters.paymentAccountId),
    });
  }
  if (filters.staffId !== undefined) {
    active.push({
      key: 'staff',
      label: 'Recorded by',
      value: staff.find((item) => item.id === filters.staffId)?.displayName ?? String(filters.staffId),
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

  const created = params.created === '1';
  const voided = params.voided === '1';
  const canCreate = can(user, 'expenses', 'create');
  const canVoid = can(user, 'expenses', 'void');
  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/expenses${buildQuery(carried)}`;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Expenses"
        description="Money spent running the shop — rent, power, transport, wages."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            <Link href="/income">
              <Button variant="secondary" size="sm">
                Other income
              </Button>
            </Link>
          </>
        }
      />

      {created && (
        <Alert tone="success" className="mb-4">
          Expense recorded. The money came out of the account you chose.
        </Alert>
      )}
      {voided && (
        <Alert tone="success" className="mb-4">
          Expense voided. The original record was kept and a reversing entry posted.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Expenses"
          value={String(summary.count)}
          hint={describeDateRange(range, preset, today)}
        />
        <Stat label="Total spent" value={money(summary.total, { currencyCode: currency })} />
        <Stat label="Average expense" value={money(summary.average, { currencyCode: currency })} />
      </div>

      <FilterBar
        basePath="/expenses"
        dateRange={{ preset, from: range.from, to: range.to }}
        active={active}
        quick={[
          {
            label: "Today's expenses",
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
            label: 'Paid from',
            allLabel: 'Any account',
            options: accounts.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'staff',
            label: 'Recorded by',
            allLabel: 'Anyone',
            options: staff.map((item) => ({ value: String(item.id), label: item.displayName })),
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
              title={isFiltered ? 'No expenses match these filters' : 'Nothing recorded yet'}
              description={
                isFiltered
                  ? 'Try widening the dates, or clear a filter to see more.'
                  : 'Record what you spend so your profit figure is real and your cash balance can be trusted.'
              }
            />
          ) : (
            <>
              <TableWrap>
                <THead>
                  <TH>
                    <SortLink
                      basePath="/expenses"
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
                      basePath="/expenses"
                      values={carried}
                      column="category"
                      activeSort={sort}
                      activeDirection={direction}
                      defaultDirection="asc"
                    >
                      Category
                    </SortLink>
                  </TH>
                  <TH>Paid from</TH>
                  <TH numeric>
                    <SortLink
                      basePath="/expenses"
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
                              action={voidExpenseAction.bind(null, row.id)}
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
                basePath="/expenses"
                values={carried}
                page={page}
                pageSize={pageSize}
                total={total}
                noun="expense"
              />
            </>
          )}

          {byCategory.length > 0 && (
            <>
              <h2 className="mt-8 mb-3 text-sm font-semibold text-content">
                Where the money went
              </h2>
              <TableWrap>
                <THead>
                  <TH>Category</TH>
                  <TH numeric>Entries</TH>
                  <TH numeric>Total</TH>
                </THead>
                <tbody>
                  {byCategory.map((row) => (
                    <TR key={row.categoryAccountId}>
                      <TD>
                        <span className="font-medium text-content">{row.categoryName}</span>
                      </TD>
                      <TD numeric>{row.count}</TD>
                      <TD numeric>{money(minor(row.total), { bare: true })}</TD>
                    </TR>
                  ))}
                  <TR className="bg-surface-sunken font-semibold">
                    <TD>Total</TD>
                    <TD numeric>{summary.count}</TD>
                    <TD numeric>{money(summary.total, { bare: true })}</TD>
                  </TR>
                </tbody>
              </TableWrap>
            </>
          )}
        </div>

        <div>
          {canCreate ? (
            <>
              <h2 className="mb-3 text-sm font-semibold text-content">Record an expense</h2>
              <CashbookForm
                action={recordExpenseAction}
                categories={categories}
                accounts={accounts}
                today={today}
                currencyCode={currency}
                submitLabel="Record expense"
                categoryLabel="Category"
                accountLabel="Paid from"
                amountLabel="Amount"
                descriptionPlaceholder="e.g. Taxi to the market"
                emptyCategoriesHint="Add a category first."
              />
              <div className="mt-3">
                <AddCategoryForm
                  action={createExpenseCategoryAction}
                  label="New expense category"
                  placeholder="e.g. Security guard"
                />
              </div>
            </>
          ) : (
            <Card>
              <p className="text-sm text-content-muted">
                You do not have permission to record expenses.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
