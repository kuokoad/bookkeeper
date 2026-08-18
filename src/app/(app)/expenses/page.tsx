import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  getExpensesByCategory,
  getExpensesTotal,
  listExpenses,
} from '@/services/cashbook.service';
import { listExpenseCategories, listPaymentAccounts } from '@/services/payment-account.service';
import {
  createExpenseCategoryAction,
  recordExpenseAction,
} from '@/actions/cashbook.actions';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { AddCategoryForm, CashbookForm } from '@/components/shared/cashbook-form';

export const metadata: Metadata = { title: 'Expenses' };
export const dynamic = 'force-dynamic';

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; voided?: string }>;
}) {
  const user = await requirePageAccess('expenses', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const rows = listExpenses(db, { from: monthStart, to: today, limit: 200 });
  const todayTotal = getExpensesTotal(db, today, today);
  const monthTotal = getExpensesTotal(db, monthStart, today);
  const byCategory = getExpensesByCategory(db, monthStart, today);

  const categories = listExpenseCategories(db);
  const accounts = listPaymentAccounts(db).map((account) => ({
    id: account.id,
    name: account.name,
    isDefault: account.isDefault,
  }));

  const canCreate = can(user, 'expenses', 'create');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Expenses"
        description="Money spent running the shop — rent, power, transport, wages."
        actions={
          <Link href="/income">
            <Button variant="secondary" size="sm">
              Other income
            </Button>
          </Link>
        }
      />

      {params.created === '1' && (
        <Alert tone="success" className="mb-4">
          Expense recorded. The money came out of the account you chose.
        </Alert>
      )}
      {params.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Expense voided. The original record was kept and a reversing entry posted.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Spent today" value={money(todayTotal)} />
        <Stat label="Spent this month" value={money(monthTotal)} />
        <Stat label="Categories used" value={String(byCategory.length)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-content">This month</h2>
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing recorded this month"
              description="Record what you spend so your profit figure is real and your cash balance can be trusted."
            />
          ) : (
            <TableWrap>
              <THead>
                <TH>Date</TH>
                <TH>Description</TH>
                <TH>Category</TH>
                <TH>Paid from</TH>
                <TH numeric>Amount</TH>
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
                      {row.status === 'VOIDED' && <Badge tone="danger">Voided</Badge>}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </TableWrap>
          )}

          {byCategory.length > 0 && (
            <>
              <h2 className="mt-8 mb-3 text-sm font-semibold text-content">
                Where the money went this month
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
                    <TD />
                    <TD numeric>{money(monthTotal, { bare: true })}</TD>
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
