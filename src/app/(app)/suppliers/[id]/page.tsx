import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, paymentAccounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getSupplier } from '@/services/supplier.service';
import { listPurchases } from '@/services/purchase.service';
import { listSupplierPayments } from '@/services/supplier-payment.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { PaySupplierForm } from './pay-supplier-form';

export const metadata: Metadata = { title: 'Supplier' };
export const dynamic = 'force-dynamic';

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; updated?: string; paid?: string; voided?: string }>;
}) {
  const user = await requirePageAccess('suppliers', 'view');
  const { id } = await params;
  const query = await searchParams;

  const supplierId = Number(id);
  if (!Number.isInteger(supplierId) || supplierId <= 0) notFound();

  let supplier;
  try {
    supplier = getSupplier(db, supplierId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const purchases = listPurchases(db, { supplierId, limit: 100 });
  const payments = listSupplierPayments(db, supplierId, 100);

  const totalBought = purchases
    .filter((purchase) => purchase.status === 'POSTED' && purchase.kind === 'PURCHASE')
    .reduce((total, purchase) => total + purchase.totalMinor, 0);
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
        title={supplier.name}
        description={supplier.contactPerson ?? supplier.phone ?? undefined}
        actions={
          <>
            <Link href="/suppliers">
              <Button variant="secondary" size="sm">
                All suppliers
              </Button>
            </Link>
            {can(user, 'suppliers', 'edit') && (
              <Link href={`/suppliers/${supplierId}/edit`}>
                <Button variant="secondary" size="sm">
                  Edit
                </Button>
              </Link>
            )}
          </>
        }
      />

      {query.created === '1' && <Alert tone="success" className="mb-4">Supplier added.</Alert>}
      {query.updated === '1' && <Alert tone="success" className="mb-4">Supplier updated.</Alert>}
      {query.paid === '1' && (
        <Alert tone="success" className="mb-4">
          Payment recorded. What you owe and your account balance were both updated.
        </Alert>
      )}
      {query.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Payment voided. The debt has been restored.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="You currently owe"
          value={money(supplier.balance, { currencyCode: currency })}
          tone={supplier.balance > 0 ? 'warning' : 'default'}
        />
        <Stat label="Total bought" value={money(minor(totalBought), { bare: true })} />
        <Stat label="Total paid later" value={money(minor(totalPaid), { bare: true })} />
      </div>

      {supplier.balance > 0 && can(user, 'suppliers', 'create') && (
        <div className="mb-6">
          <PaySupplierForm
            supplierId={supplierId}
            supplierName={supplier.name}
            balanceMinor={supplier.balance as number}
            accounts={accounts}
            today={toBusinessDate()}
            currencyCode={currency}
          />
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-content">Purchases</h2>
      {purchases.length === 0 ? (
        <Card className="mb-6">
          <p className="text-sm text-content-muted">No purchases recorded from this supplier yet.</p>
        </Card>
      ) : (
        <TableWrap className="mb-6">
          <THead>
            <TH>Reference</TH>
            <TH>Date</TH>
            <TH numeric>Total</TH>
            <TH numeric>Owing</TH>
            <TH>Status</TH>
          </THead>
          <tbody>
            {purchases.map((purchase) => (
              <TR key={purchase.id}>
                <TD>
                  <Link
                    href={`/purchases/${purchase.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {purchase.purchaseNo}
                  </Link>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(purchase.businessDate)}
                  </span>
                </TD>
                <TD numeric>{money(minor(purchase.totalMinor), { bare: true })}</TD>
                <TD numeric>
                  {purchase.outstandingMinor > 0 ? (
                    <span className="font-medium text-warning">
                      {money(minor(purchase.outstandingMinor), { bare: true })}
                    </span>
                  ) : (
                    <span className="text-content-subtle">—</span>
                  )}
                </TD>
                <TD>
                  {purchase.status === 'VOIDED' ? (
                    <Badge tone="danger">Voided</Badge>
                  ) : purchase.kind === 'RETURN' ? (
                    <Badge tone="accent">Return</Badge>
                  ) : purchase.outstandingMinor > 0 ? (
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

      <h2 className="mb-3 text-sm font-semibold text-content">Payments made</h2>
      {payments.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">
            No separate payments yet. Money paid at the time of a purchase is shown on that record.
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
                    <Badge tone="success">Paid</Badge>
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
