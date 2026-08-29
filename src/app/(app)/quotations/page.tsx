import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { countQuotations, isExpired, listQuotations } from '@/services/quotation.service';
import { listCustomers } from '@/services/customer.service';
import { parseQuotationFilters } from '@/lib/list-filters';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageHeader } from '@/components/ui/page';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Quotations' };
export const dynamic = 'force-dynamic';

export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageAccess('quotations', 'view');
  const params = await searchParams;
  const today = toBusinessDate();

  // One parser, shared with the CSV route. See lib/list-filters.ts.
  const { filters, range, preset, page, pageSize, carried } = parseQuotationFilters(params, today);

  const total = countQuotations(db, filters, today);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);

  const rows = listQuotations(
    db,
    { ...filters, limit: pageSize, offset: (currentPage - 1) * pageSize },
    today,
  );

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';
  const customers = listCustomers(db, {});

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Quotations"
        description="Prices offered to customers. Nothing here has been sold."
        actions={
          can(user, 'quotations', 'create') ? (
            <Link href="/quotations/new">
              <Button size="sm">New quote</Button>
            </Link>
          ) : undefined
        }
      />

      <FilterBar
        basePath="/quotations"
        active={[]}
        dateRange={{ preset, from: range.from, to: range.to }}
        quick={[
          { label: 'Open', params: { status: 'OPEN' }, match: { status: 'OPEN' } },
          { label: 'Ran out', params: { expired: '1' }, match: { expired: '1' } },
          {
            label: 'Became sales',
            params: { status: 'CONVERTED' },
            match: { status: 'CONVERTED' },
          },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Quote number, customer or job',
            wide: true,
          },
          {
            kind: 'select',
            key: 'customer',
            label: 'Customer',
            allLabel: 'Everyone',
            options: customers.map((customer) => ({
              value: String(customer.id),
              label: customer.name,
            })),
          },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No quotes here"
          description="A quote is a price a customer can take away and think about. It sells nothing until they accept it."
        />
      ) : (
        <Card className="mt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-content-muted">
                  <th className="pb-2 font-medium">Quote</th>
                  <th className="pb-2 font-medium">Customer</th>
                  <th className="pb-2 font-medium">Issued</th>
                  <th className="pb-2 font-medium">Valid until</th>
                  <th className="pb-2 text-right font-medium">Total</th>
                  <th className="pb-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((quote) => {
                  const expired = isExpired(quote, today);
                  return (
                    <tr key={quote.id} className="border-b border-line">
                      <td className="py-2.5">
                        <Link
                          href={`/quotations/${quote.id}`}
                          className="font-medium text-accent hover:underline"
                        >
                          {quote.quoteNo}
                        </Link>
                      </td>
                      <td className="py-2.5 text-content">
                        <span className="block">{quote.customerName}</span>
                        {quote.reference && (
                          <span className="block text-xs text-content-muted">
                            {quote.reference}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-content-muted">
                        {formatDate(quote.businessDate)}
                      </td>
                      <td
                        className={`py-2.5 ${expired ? 'font-medium text-warning' : 'text-content-muted'}`}
                      >
                        {formatDate(quote.validUntil)}
                      </td>
                      <td className="tabular py-2.5 text-right font-medium text-content">
                        {money(minor(quote.totalMinor), { currencyCode: currency })}
                      </td>
                      <td className="py-2.5 text-right">
                        {quote.status === 'CONVERTED' && <Badge tone="success">Sold</Badge>}
                        {quote.status === 'CANCELLED' && <Badge tone="neutral">Cancelled</Badge>}
                        {quote.status === 'OPEN' && expired && (
                          <Badge tone="warning">Ran out</Badge>
                        )}
                        {quote.status === 'OPEN' && !expired && <Badge tone="accent">Open</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            basePath="/quotations"
            values={carried}
            page={currentPage}
            pageSize={pageSize}
            total={total}
            noun="quote"
            nounPlural="quotes"
          />
        </Card>
      )}
    </div>
  );
}
