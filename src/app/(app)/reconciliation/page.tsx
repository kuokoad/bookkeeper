import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  getReconciliationContext,
  getReconciliationOverview,
  listReconciliations,
} from '@/services/reconciliation.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor, sum } from '@/domain/money';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { CountForm } from './count-form';
import { RowVoidForm } from '@/components/shared/row-void-form';
import { voidReconciliationAction } from '@/actions/reconciliation.actions';

export const metadata: Metadata = { title: 'Reconciliation' };
export const dynamic = 'force-dynamic';

const KIND_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MOBILE_MONEY: 'Mobile money',
  BANK: 'Bank',
  OTHER: 'Other',
};

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ voided?: string }>;
}) {
  const user = await requirePageAccess('reconciliation', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const overview = getReconciliationOverview(db);
  const history = listReconciliations(db, undefined, 100);

  // Expected balance per account, as at today, for the live difference display.
  const expectedByAccount: Record<number, number> = {};
  for (const account of overview) {
    expectedByAccount[account.paymentAccountId] = getReconciliationContext(
      db,
      account.paymentAccountId,
      today,
    ).expected as number;
  }

  const unresolved = sum(overview.map((account) => account.unresolvedDifference));
  const neverCounted = overview.filter((account) => account.lastCountedOn === null);
  const canCount = can(user, 'reconciliation', 'create');
  const canVoid = can(user, 'reconciliation', 'void');

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Reconciliation"
        description="Check what the books say against what is actually there."
      />

      {params.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Count voided. Any adjustment was reversed and the record kept.
        </Alert>
      )}

      {unresolved !== 0 && (
        <Alert tone="warning" title="There is money still unaccounted for" className="mb-4">
          {money(unresolved, { currencyCode: currency })} of differences have been recorded but not
          resolved. Either find the money, or record a count that corrects the books.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          icon="accounts"
          label="Accounts"
          value={String(overview.length)}
          hint={neverCounted.length > 0 ? `${neverCounted.length} never counted` : 'All counted'}
        />
        <Stat
          icon="warning"
          label="Unresolved differences"
          value={money(unresolved)}
          tone={unresolved !== 0 ? 'warning' : 'success'}
        />
        <Stat icon="books" label="Counts recorded" value={String(history.length)} />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-content">Where each account stands</h2>
      <TableWrap className="mb-8">
        <THead>
          <TH>Account</TH>
          <TH>Type</TH>
          <TH numeric>Books say</TH>
          <TH>Last counted</TH>
          <TH numeric>Last difference</TH>
          <TH numeric>Unresolved</TH>
        </THead>
        <tbody>
          {overview.map((account) => (
            <TR key={account.paymentAccountId}>
              <TD>
                <Link
                  href={`/accounts/${account.paymentAccountId}`}
                  className="font-medium text-accent hover:underline"
                >
                  {account.accountName}
                </Link>
              </TD>
              <TD>
                <span className="text-content-muted">
                  {KIND_LABELS[account.kind] ?? account.kind}
                </span>
              </TD>
              <TD numeric>{money(account.currentBalance, { bare: true })}</TD>
              <TD>
                {account.lastCountedOn === null ? (
                  <Badge tone="neutral">Never</Badge>
                ) : (
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(account.lastCountedOn)}
                  </span>
                )}
              </TD>
              <TD numeric>
                {account.lastDifference === null ? (
                  <span className="text-content-subtle">—</span>
                ) : account.lastDifference === 0 ? (
                  <Badge tone="success">Agreed</Badge>
                ) : (
                  <span className="font-medium text-warning">
                    {money(account.lastDifference, { bare: true })}
                  </span>
                )}
              </TD>
              <TD numeric>
                {account.unresolvedDifference === 0 ? (
                  <span className="text-content-subtle">—</span>
                ) : (
                  <span className="font-medium text-danger">
                    {money(account.unresolvedDifference, { bare: true })}
                  </span>
                )}
              </TD>
            </TR>
          ))}
        </tbody>
      </TableWrap>

      <div className="grid gap-8 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <h2 className="mb-3 text-sm font-semibold text-content">Past counts</h2>
          {history.length === 0 ? (
            <EmptyState
              title="Nothing counted yet"
              description="Counting the till at the end of the day is the quickest way to catch a mistake while you can still remember what happened."
            />
          ) : (
            <TableWrap>
              <THead>
                <TH>Reference</TH>
                <TH>Date</TH>
                <TH>Account</TH>
                <TH numeric>Books</TH>
                <TH numeric>Counted</TH>
                <TH numeric>Difference</TH>
                <TH>Outcome</TH>
                <TH />
              </THead>
              <tbody>
                {history.map((row) => (
                  <TR key={row.id}>
                    <TD>
                      <span className="font-medium text-content">{row.reconciliationNo}</span>
                      {row.explanation && (
                        <span className="mt-0.5 block text-xs text-content-subtle">
                          {row.explanation}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <span className="whitespace-nowrap text-content-muted">
                        {formatDate(row.businessDate)}
                      </span>
                    </TD>
                    <TD>
                      <span className="text-content-muted">{row.accountName}</span>
                    </TD>
                    <TD numeric>{money(minor(row.expectedMinor), { bare: true })}</TD>
                    <TD numeric>{money(minor(row.actualMinor), { bare: true })}</TD>
                    <TD numeric>
                      {row.differenceMinor === 0 ? (
                        <span className="text-content-subtle">—</span>
                      ) : (
                        <span
                          className={row.differenceMinor < 0 ? 'font-medium text-danger' : 'font-medium text-success'}
                        >
                          {money(minor(row.differenceMinor), { bare: true })}
                        </span>
                      )}
                    </TD>
                    <TD>
                      {row.status === 'VOIDED' ? (
                        <Badge tone="danger">Voided</Badge>
                      ) : row.differenceMinor === 0 ? (
                        <Badge tone="success">Agreed</Badge>
                      ) : row.adjusted ? (
                        <Badge tone="accent">Adjusted</Badge>
                      ) : (
                        <Badge tone="warning">Open</Badge>
                      )}
                    </TD>
                    <TD>
                      {row.status !== 'VOIDED' && canVoid && (
                        <RowVoidForm
                          action={voidReconciliationAction.bind(null, row.id)}
                          what={row.reconciliationNo}
                          placeholder="e.g. Counted the wrong till"
                        />
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </TableWrap>
          )}
        </div>

        <div className="lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-content">Count an account</h2>
          {canCount ? (
            <CountForm
              accounts={overview.map((account) => ({
                id: account.paymentAccountId,
                name: account.accountName,
                kind: account.kind,
                balanceMinor: account.currentBalance as number,
              }))}
              today={today}
              currencyCode={currency}
              expectedByAccount={expectedByAccount}
            />
          ) : (
            <p className="rounded-xl border border-line bg-surface-raised p-4 text-sm text-content-muted">
              You do not have permission to record a count.
            </p>
          )}
        </div>
      </div>

      <p className="mt-6 text-xs text-content-subtle">
        Once an account has been counted and agreed, closing the books up to that date under{' '}
        <Link href="/accounting" className="text-accent hover:underline">
          Accounting
        </Link>{' '}
        stops anything being added behind it.
      </p>
    </div>
  );
}
