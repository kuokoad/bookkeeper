import Link from 'next/link';

import type { AgeingRow } from '@/services/reporting/ledger.service';
import { formatDate, money } from '@/lib/format';
import { minor, sum } from '@/domain/money';
import { EmptyState } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

/**
 * Debt by age.
 *
 * The buckets are the ones a shop owner actually uses when deciding who to
 * chase: not yet due, up to a month, and so on. The oldest column is what
 * matters, so it is placed last where the eye lands.
 */
export function AgeingTable({
  rows,
  hrefBase,
  emptyTitle,
  emptyDescription,
  nameHeading,
}: {
  rows: AgeingRow[];
  hrefBase: string;
  emptyTitle: string;
  emptyDescription: string;
  nameHeading: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const totals = {
    current: sum(rows.map((row) => row.current)),
    days1to30: sum(rows.map((row) => row.days1to30)),
    days31to60: sum(rows.map((row) => row.days31to60)),
    days61to90: sum(rows.map((row) => row.days61to90)),
    over90: sum(rows.map((row) => row.over90)),
    total: sum(rows.map((row) => row.total)),
  };

  return (
    <TableWrap>
      <THead>
        <TH>{nameHeading}</TH>
        <TH>Oldest</TH>
        <TH numeric>Not due</TH>
        <TH numeric>1–30 days</TH>
        <TH numeric>31–60</TH>
        <TH numeric>61–90</TH>
        <TH numeric>Over 90</TH>
        <TH numeric>Total</TH>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TR key={row.partyId}>
            <TD>
              <Link
                href={`${hrefBase}/${row.partyId}`}
                className="font-medium text-accent hover:underline"
              >
                {row.partyName}
              </Link>
              {row.phone && (
                <span className="mt-0.5 block text-xs text-content-subtle">{row.phone}</span>
              )}
            </TD>
            <TD>
              <span className="whitespace-nowrap text-content-muted">
                {row.oldestDate ? formatDate(row.oldestDate) : '—'}
              </span>
            </TD>
            <TD numeric>{row.current > 0 ? money(row.current, { bare: true }) : '—'}</TD>
            <TD numeric>{row.days1to30 > 0 ? money(row.days1to30, { bare: true }) : '—'}</TD>
            <TD numeric>{row.days31to60 > 0 ? money(row.days31to60, { bare: true }) : '—'}</TD>
            <TD numeric>{row.days61to90 > 0 ? money(row.days61to90, { bare: true }) : '—'}</TD>
            <TD numeric>
              {row.over90 > 0 ? (
                <span className="font-medium text-danger">{money(row.over90, { bare: true })}</span>
              ) : (
                '—'
              )}
            </TD>
            <TD numeric>
              <span className="font-semibold">{money(row.total, { bare: true })}</span>
            </TD>
          </TR>
        ))}
        <TR className="bg-surface-sunken font-semibold">
          <TD>Total</TD>
          <TD />
          <TD numeric>{money(minor(totals.current), { bare: true })}</TD>
          <TD numeric>{money(minor(totals.days1to30), { bare: true })}</TD>
          <TD numeric>{money(minor(totals.days31to60), { bare: true })}</TD>
          <TD numeric>{money(minor(totals.days61to90), { bare: true })}</TD>
          <TD numeric>{money(minor(totals.over90), { bare: true })}</TD>
          <TD numeric>{money(minor(totals.total), { bare: true })}</TD>
        </TR>
      </tbody>
    </TableWrap>
  );
}
