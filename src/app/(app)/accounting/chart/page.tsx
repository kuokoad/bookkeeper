import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getChartOfAccounts } from '@/services/reporting/ledger.service';
import { money } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Chart of accounts' };
export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<string, string> = {
  ASSET: 'Asset',
  LIABILITY: 'Liability',
  EQUITY: 'Equity',
  CONTRA_EQUITY: 'Equity (contra)',
  REVENUE: 'Revenue',
  CONTRA_REVENUE: 'Revenue (contra)',
  COGS: 'Cost of sales',
  EXPENSE: 'Expense',
};

const TYPE_TONES: Record<string, 'success' | 'warning' | 'accent' | 'neutral'> = {
  ASSET: 'success',
  LIABILITY: 'warning',
  EQUITY: 'accent',
  CONTRA_EQUITY: 'accent',
  REVENUE: 'success',
  CONTRA_REVENUE: 'neutral',
  COGS: 'warning',
  EXPENSE: 'warning',
};

export default async function ChartOfAccountsPage() {
  await requirePageAccess('accounts', 'view');
  const chart = getChartOfAccounts(db);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Chart of accounts"
        description="Every account the books are kept in. Balances are calculated from the ledger."
        actions={
          <Link href="/accounting">
            <Button variant="secondary" size="sm">
              Back to accounting
            </Button>
          </Link>
        }
      />

      <TableWrap>
        <THead>
          <TH>Code</TH>
          <TH>Account</TH>
          <TH>Type</TH>
          <TH numeric>Entries</TH>
          <TH numeric>Balance</TH>
          <TH />
        </THead>
        <tbody>
          {chart.map((account) => (
            <TR key={account.id} className={account.isHeader ? 'bg-surface-sunken' : undefined}>
              <TD>
                <span className="tabular text-xs text-content-subtle">{account.code}</span>
              </TD>
              <TD>
                <span
                  className={account.isHeader ? 'font-semibold text-content' : 'text-content'}
                  style={{ paddingLeft: `${account.depth * 1.25}rem` }}
                >
                  {account.name}
                </span>
                {!account.isActive && (
                  <Badge tone="neutral" className="ml-2">
                    Archived
                  </Badge>
                )}
              </TD>
              <TD>
                <Badge tone={TYPE_TONES[account.type] ?? 'neutral'}>
                  {TYPE_LABELS[account.type] ?? account.type}
                </Badge>
              </TD>
              <TD numeric>
                {account.isHeader ? (
                  <span className="text-content-subtle">—</span>
                ) : (
                  account.entryCount
                )}
              </TD>
              <TD numeric>
                <span className={account.isHeader ? 'font-semibold' : ''}>
                  {money(account.isHeader ? account.rollup : account.balance, { bare: true })}
                </span>
              </TD>
              <TD>
                <div className="flex justify-end">
                  {!account.isHeader && account.entryCount > 0 && (
                    <Link
                      href={`/accounting/ledger/${account.id}`}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      Ledger
                    </Link>
                  )}
                </div>
              </TD>
            </TR>
          ))}
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        Headings show the total of everything beneath them. Open an account&rsquo;s ledger to see
        the individual entries that produced its balance.
      </p>
    </div>
  );
}
