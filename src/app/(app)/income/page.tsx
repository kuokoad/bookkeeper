import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getIncomesTotal, listIncomes } from '@/services/cashbook.service';
import { listIncomeCategories, listPaymentAccounts } from '@/services/payment-account.service';
import { createIncomeCategoryAction, recordIncomeAction } from '@/actions/cashbook.actions';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { AddCategoryForm, CashbookForm } from '@/components/shared/cashbook-form';

export const metadata: Metadata = { title: 'Other income' };
export const dynamic = 'force-dynamic';

export default async function IncomePage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; voided?: string }>;
}) {
  const user = await requirePageAccess('income', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const rows = listIncomes(db, { from: monthStart, to: today, limit: 200 });
  const todayTotal = getIncomesTotal(db, today, today);
  const monthTotal = getIncomesTotal(db, monthStart, today);

  const categories = listIncomeCategories(db);
  const accounts = listPaymentAccounts(db).map((account) => ({
    id: account.id,
    name: account.name,
    isDefault: account.isDefault,
  }));

  const canCreate = can(user, 'income', 'create');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Other income"
        description="Money in that is not a product sale — commission, services, anything else."
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

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Stat label="Received today" value={money(todayTotal)} />
        <Stat label="Received this month" value={money(monthTotal)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-content">This month</h2>
          {rows.length === 0 ? (
            <EmptyState
              title="No other income this month"
              description="Use this for money that is not from selling stock, so it does not get mixed into your sales figures."
            />
          ) : (
            <TableWrap>
              <THead>
                <TH>Date</TH>
                <TH>Description</TH>
                <TH>Category</TH>
                <TH>Received into</TH>
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
                    <TD>{row.status === 'VOIDED' && <Badge tone="danger">Voided</Badge>}</TD>
                  </TR>
                ))}
              </tbody>
            </TableWrap>
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
