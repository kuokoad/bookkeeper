import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, paymentAccounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getCustomer } from '@/services/customer.service';
import { listSales } from '@/services/sale.service';
import { getOpenSales, listCustomerPayments } from '@/services/customer-payment.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { ReceivePaymentForm } from './receive-payment-form';

export const metadata: Metadata = { title: 'Customer' };
export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; updated?: string; paid?: string; voided?: string }>;
}) {
  const user = await requirePageAccess('customers', 'view');
  const { id } = await params;
  const query = await searchParams;

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

  const sales = listSales(db, { customerId, limit: 100 });
  const payments = listCustomerPayments(db, customerId, 100);
  const openSales = getOpenSales(db, customerId);

  const totalBought = sales
    .filter((sale) => sale.status === 'POSTED')
    .reduce((total, sale) => total + sale.totalMinor, 0);
  const totalPaid = payments
    .filter((payment) => payment.status === 'POSTED')
    .reduce((total, payment) => total + payment.amountMinor, 0);

  const accounts = db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(paymentAccounts.sortOrder)
    .all()
    .map((account) => ({ id: account.id, name: account.name, isDefault: account.isDefault }));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={customer.name}
        description={customer.phone ?? undefined}
        actions={
          <>
            <Link href="/customers">
              <Button variant="secondary" size="sm">
                All customers
              </Button>
            </Link>
            {can(user, 'customers', 'edit') && (
              <Link href={`/customers/${customerId}/edit`}>
                <Button variant="secondary" size="sm">
                  Edit
                </Button>
              </Link>
            )}
          </>
        }
      />

      {query.created === '1' && (
        <Alert tone="success" className="mb-4">
          Customer added.
        </Alert>
      )}
      {query.updated === '1' && (
        <Alert tone="success" className="mb-4">
          Customer updated.
        </Alert>
      )}
      {query.paid === '1' && (
        <Alert tone="success" className="mb-4">
          Payment recorded. Their balance and your cash account were both updated.
        </Alert>
      )}
      {query.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Payment voided. The debt has been restored.
        </Alert>
      )}

      {customer.overLimit && (
        <Alert tone="danger" title="Over their credit limit" className="mb-4">
          {customer.name} owes {money(customer.balance, { currencyCode: currency })} against a limit
          of {money(customer.creditLimit ?? minor(0), { currencyCode: currency })}. New credit sales
          will be refused.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat
          label="Currently owes"
          value={money(customer.balance, { currencyCode: currency })}
          tone={customer.balance > 0 ? 'warning' : 'default'}
        />
        <Stat label="Total bought" value={money(minor(totalBought), { bare: true })} />
        <Stat label="Total paid later" value={money(minor(totalPaid), { bare: true })} />
        <Stat
          label="Credit limit"
          value={
            customer.creditLimit === null ? 'No limit' : money(customer.creditLimit, { bare: true })
          }
          hint={
            customer.headroom === null
              ? undefined
              : `${money(customer.headroom, { bare: true })} available`
          }
        />
      </div>

      {customer.balance > 0 && can(user, 'customers', 'create') && (
        <div className="mb-6">
          <ReceivePaymentForm
            customerId={customerId}
            customerName={customer.name}
            balanceMinor={customer.balance as number}
            accounts={accounts}
            today={toBusinessDate()}
            currencyCode={currency}
            openSales={openSales.map((sale) => ({
              receiptNo: sale.receiptNo,
              outstandingMinor: sale.outstandingMinor as number,
              businessDate: sale.businessDate,
            }))}
          />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-content">Sales</h2>
      {sales.length === 0 ? (
        <Card className="mb-6">
          <p className="text-sm text-content-muted">No sales recorded for this customer yet.</p>
        </Card>
      ) : (
        <TableWrap className="mb-6">
          <THead>
            <TH>Receipt</TH>
            <TH>Date</TH>
            <TH numeric>Total</TH>
            <TH numeric>Owing</TH>
            <TH>Status</TH>
          </THead>
          <tbody>
            {sales.map((sale) => (
              <TR key={sale.id}>
                <TD>
                  <Link href={`/sales/${sale.id}`} className="font-medium text-accent hover:underline">
                    {sale.receiptNo}
                  </Link>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(sale.businessDate)}
                  </span>
                </TD>
                <TD numeric>{money(minor(sale.totalMinor), { bare: true })}</TD>
                <TD numeric>
                  {sale.outstandingMinor > 0 ? (
                    <span className="font-medium text-warning">
                      {money(minor(sale.outstandingMinor), { bare: true })}
                    </span>
                  ) : (
                    <span className="text-content-subtle">—</span>
                  )}
                </TD>
                <TD>
                  {sale.status === 'VOIDED' ? (
                    <Badge tone="danger">Voided</Badge>
                  ) : sale.outstandingMinor > 0 ? (
                    <Badge tone="warning">Credit</Badge>
                  ) : (
                    <Badge tone="success">Paid</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}

      <h2 className="mb-3 text-sm font-semibold text-content">Payments received</h2>
      {payments.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">
            No separate payments yet. Money taken at the time of a sale is shown on that receipt.
          </p>
        </Card>
      ) : (
        <TableWrap>
          <THead>
            <TH>Reference</TH>
            <TH>Date</TH>
            <TH>Method</TH>
            <TH numeric>Amount</TH>
            <TH>Status</TH>
          </THead>
          <tbody>
            {payments.map((payment) => (
              <TR key={payment.id}>
                <TD>
                  <span className="font-medium text-content">{payment.paymentNo}</span>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(payment.businessDate)}
                  </span>
                </TD>
                <TD>{payment.accountName}</TD>
                <TD numeric>{money(minor(payment.amountMinor), { bare: true })}</TD>
                <TD>
                  {payment.status === 'VOIDED' ? (
                    <Badge tone="danger">Voided</Badge>
                  ) : (
                    <Badge tone="success">Received</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
