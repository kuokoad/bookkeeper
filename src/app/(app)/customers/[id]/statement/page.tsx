import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, eq, lte } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, sales } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getCustomer, getCustomerBalance } from '@/services/customer.service';
import { getOutstandingBySale } from '@/services/sale.service';
import { daysOverdue } from '@/domain/business-date';
import { minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/page';
import { PrintButton } from '../../../sales/[id]/receipt/print-button';

export const metadata: Metadata = { title: 'Statement' };
export const dynamic = 'force-dynamic';

/**
 * Everything one customer still owes, as at a date.
 *
 * The document to hand someone who asks "what do I owe you?" — or to send at
 * month end to a regular who settles periodically. It lists the unpaid
 * invoices, what is overdue, and one total.
 *
 * The total is `getCustomerBalance`, the same figure the ledger produces
 * everywhere else, not a sum of the rows above it. If those two ever
 * disagreed, the statement says so rather than quietly showing the friendlier
 * number.
 */
export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('customers', 'view');
  const { id } = await params;

  const customerId = Number(id);
  if (!Number.isInteger(customerId) || customerId <= 0) notFound();

  let customer;
  try {
    customer = getCustomer(db, customerId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';
  const today = toBusinessDate();

  const outstandingBySale = getOutstandingBySale(db);

  const rows = db
    .select({
      id: sales.id,
      receiptNo: sales.receiptNo,
      invoiceNo: sales.invoiceNo,
      businessDate: sales.businessDate,
      dueDate: sales.dueDate,
      totalMinor: sales.totalMinor,
    })
    .from(sales)
    .where(
      and(
        eq(sales.customerId, customerId),
        eq(sales.status, 'POSTED'),
        lte(sales.businessDate, today),
      ),
    )
    .orderBy(asc(sales.businessDate))
    .all()
    .map((row) => ({ ...row, outstanding: outstandingBySale.get(row.id) ?? minor(0) }))
    .filter((row) => row.outstanding > 0);

  // The authority. Not a sum of the rows above.
  const balance = getCustomerBalance(db, customerId);
  const rowsTotal = rows.reduce((running, row) => running + row.outstanding, 0);
  const agrees = rowsTotal === balance;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 no-print">
        <Link href={`/customers/${customer.id}`}>
          <Button variant="secondary" size="sm">
            Back to {customer.name}
          </Button>
        </Link>
        <PrintButton />
      </div>

      {!agrees && (
        <Alert tone="danger" title="This statement does not tie to the ledger" className="mb-4">
          The unpaid invoices come to {money(minor(rowsTotal), { currencyCode: currency })}, but the
          account balance is {money(balance, { currencyCode: currency })}. Do not send this until it
          is resolved.
        </Alert>
      )}

      <article className="rounded-xl border border-line bg-surface-raised p-6 text-sm">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {settings?.logoData && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/logo?v=${settings.logoUpdatedAt?.getTime() ?? 0}`}
                alt=""
                className="mb-2 max-h-14 max-w-36 object-contain"
              />
            )}
            <h1 className="text-lg font-semibold text-content">
              {settings?.businessName ?? 'NunaBooks'}
            </h1>
            {settings?.tagline && <p className="text-xs text-content-muted">{settings.tagline}</p>}
            {settings?.phone && <p className="text-xs text-content-muted">{settings.phone}</p>}
          </div>

          <div className="shrink-0 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Statement
            </p>
            <p className="text-xs text-content-muted">As at {formatDate(today)}</p>
          </div>
        </header>

        <section className="mb-6 border-y border-line py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            Account
          </p>
          <p className="font-medium text-content">{customer.name}</p>
          {customer.phone && <p className="text-xs text-content-muted">{customer.phone}</p>}
        </section>

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description={`${customer.name} owes nothing as at ${formatDate(today)}.`}
          />
        ) : (
          <>
            <table className="mb-4 w-full text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-content-subtle">
                  <th className="py-1.5 text-left font-medium">Document</th>
                  <th className="py-1.5 text-left font-medium">Dated</th>
                  <th className="py-1.5 text-left font-medium">Due</th>
                  <th className="py-1.5 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const over = row.dueDate ? daysOverdue(row.dueDate, today) : 0;
                  return (
                    <tr key={row.id} className="border-b border-line last:border-b-0">
                      <td className="py-1.5 pr-2 text-content">{row.invoiceNo ?? row.receiptNo}</td>
                      <td className="py-1.5 pr-2 text-content-muted">
                        {formatDate(row.businessDate)}
                      </td>
                      <td className="py-1.5 pr-2">
                        {row.dueDate ? (
                          <span className={over > 0 ? 'font-medium text-danger' : 'text-content-muted'}>
                            {formatDate(row.dueDate)}
                            {over > 0 && ` · ${over}d late`}
                          </span>
                        ) : (
                          <span className="text-content-subtle">—</span>
                        )}
                      </td>
                      <td className="tabular py-1.5 text-right text-content">
                        {money(row.outstanding, { currencyCode: currency, bare: true })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <dl className="ml-auto max-w-xs">
              <div className="flex justify-between gap-4 border-t-2 border-line-strong pt-2">
                <dt className="font-semibold text-content">Total owed</dt>
                <dd className="tabular text-lg font-semibold text-content">
                  {money(balance, { currencyCode: currency })}
                </dd>
              </div>
            </dl>
          </>
        )}

        <footer className="mt-6 border-t border-line pt-4 text-xs text-content-muted">
          <p>
            This statement covers everything unpaid as at {formatDate(today)}. Payments made after
            that date are not included.
          </p>
        </footer>
      </article>
    </div>
  );
}
