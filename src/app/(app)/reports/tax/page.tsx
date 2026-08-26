import type { Metadata } from 'next';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getTaxReturn } from '@/services/reporting/tax-return.service';
import { getTaxProfile } from '@/services/tax.service';
import { money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod } from '@/components/shared/period-filter';
import { FilterBar } from '@/components/shared/filter-bar';
import { buildQuery } from '@/lib/filters';
import { parseReportPeriod, type SearchParams } from '@/lib/list-filters';
import { ReportActions } from '@/components/shared/report-actions';

export const metadata: Metadata = { title: 'Tax return' };
export const dynamic = 'force-dynamic';

/**
 * What the shop owes the tax authority, ready to be copied onto a return.
 *
 * Deliberately NOT called a GRA form, and deliberately not laid out as one. The
 * form changes, and a screen pretending to be one would be trusted past the
 * point where it was still right. This shows the figures the return asks for,
 * each traceable to documents in this database, and leaves the filing to the
 * person who signs it.
 */
export default async function TaxReturnPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const { range: period, preset, carried } = parseReportPeriod(params, toBusinessDate());
  const taxReturn = getTaxReturn(db, period);
  const profile = getTaxProfile(db);

  const owed = taxReturn.netPayable > 0;
  const reclaimable = taxReturn.netPayable < 0;
  const nothingToReport = taxReturn.components.length === 0;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Tax return"
        description={`What you owe, ${describePeriod(period, preset).toLowerCase()}`}
        actions={
          <ReportActions csvHref={`/api/reports/tax${buildQuery(carried)}`} />
        }
      />

      <FilterBar basePath="/reports/tax" dateRange={{ preset, from: period.from, to: period.to }} />

      {!profile.enabled && (
        <Alert tone="info" title="Tax is switched off" className="mb-4">
          This shop is not charging tax, so there is nothing to return. Turn it on in Settings if
          the shop is registered.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Tax you charged"
          value={money(taxReturn.totalOutput)}
          hint="On sales, less returns"
        />
        <Stat
          label="Tax you can reclaim"
          value={money(taxReturn.totalRecoverableInput)}
          hint="On purchases, less returns"
        />
        {/*
          Nothing owed is its own answer, and neither "you owe" nor "the
          authority owes you" describes it. Saying one of them anyway is how a
          screen teaches people not to read it.
        */}
        <Stat
          label={owed ? 'You owe' : reclaimable ? 'Reclaimable' : 'Nothing owed'}
          value={money(Math.abs(taxReturn.netPayable) as typeof taxReturn.netPayable)}
          tone={owed ? 'warning' : reclaimable ? 'success' : 'default'}
          hint={
            owed
              ? 'Pay this to the authority'
              : reclaimable
                ? 'The authority owes you this'
                : 'Charged and reclaimable cancel out'
          }
        />
        <Stat
          label="Sales it was charged on"
          value={money(taxReturn.taxableSalesMinor)}
          hint={`${taxReturn.saleCount} document${taxReturn.saleCount === 1 ? '' : 's'}`}
        />
      </div>

      {nothingToReport ? (
        <Alert tone="info" title="Nothing to report for this period">
          No sale or purchase in this period carried tax.
        </Alert>
      ) : (
        <>
          <h2 className="mb-3 text-sm font-semibold text-content">Each tax, separately</h2>
          <TableWrap className="mb-4">
            <THead>
              <TH>Tax</TH>
              <TH numeric>Charged on sales</TH>
              <TH numeric>Paid on purchases</TH>
              <TH numeric>Reclaimable</TH>
              <TH numeric>Net</TH>
            </THead>
            <tbody>
              {taxReturn.components.map((component) => {
                const paid = component.recoverableInputMinor + component.nonRecoverableInputMinor;
                return (
                  <TR key={component.code}>
                    <TD>
                      <span className="font-medium text-content">{component.name}</span>
                    </TD>
                    <TD numeric>{money(component.outputMinor, { bare: true })}</TD>
                    <TD numeric>{money(paid as typeof component.outputMinor, { bare: true })}</TD>
                    <TD numeric>
                      {money(component.recoverableInputMinor, { bare: true })}
                      {component.nonRecoverableInputMinor !== 0 && (
                        <span className="block text-xs text-content-subtle">
                          {money(component.nonRecoverableInputMinor, { bare: true })} not
                          reclaimable
                        </span>
                      )}
                    </TD>
                    <TD numeric>
                      <span
                        className={
                          component.netMinor > 0
                            ? 'font-medium text-warning'
                            : component.netMinor < 0
                              ? 'font-medium text-success'
                              : 'text-content'
                        }
                      >
                        {money(component.netMinor, { bare: true })}
                      </span>
                    </TD>
                  </TR>
                );
              })}
              <TR>
                <TD>
                  <span className="font-semibold text-content">Total</span>
                </TD>
                <TD numeric>
                  <span className="font-semibold">
                    {money(taxReturn.totalOutput, { bare: true })}
                  </span>
                </TD>
                <TD numeric>
                  <span className="font-semibold">
                    {money(
                      (taxReturn.totalRecoverableInput +
                        taxReturn.totalNonRecoverableInput) as typeof taxReturn.totalOutput,
                      { bare: true },
                    )}
                  </span>
                </TD>
                <TD numeric>
                  <span className="font-semibold">
                    {money(taxReturn.totalRecoverableInput, { bare: true })}
                  </span>
                </TD>
                <TD numeric>
                  <span className="font-semibold">
                    {money(taxReturn.netPayable, { bare: true })}
                  </span>
                </TD>
              </TR>
            </tbody>
          </TableWrap>

          {taxReturn.totalNonRecoverableInput !== 0 && (
            <p className="mb-6 text-xs text-content-muted">
              Tax marked &ldquo;not reclaimable&rdquo; was paid to suppliers but cannot be claimed
              back. It went into the cost of the goods and out again through cost of sales, so it
              is already in your profit figure and must not be entered on the return.
            </p>
          )}

          <Alert tone={owed ? 'warning' : 'info'} title="Before you file this">
            <p>
              These figures come from {taxReturn.saleCount} sales document
              {taxReturn.saleCount === 1 ? '' : 's'} and {taxReturn.purchaseCount} purchase document
              {taxReturn.purchaseCount === 1 ? '' : 's'} dated inside the period, cancellations
              included. A sale cancelled after a return was filed appears in the period it was
              cancelled, not the one it was made — which is how it should be, and means an earlier
              period will not change under you.
            </p>
            <p className="mt-2">
              Check them against your own records before filing. This is a summary of what this
              shop recorded, not tax advice.
            </p>
          </Alert>
        </>
      )}
    </div>
  );
}
