import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { listPaymentAccounts } from '@/services/payment-account.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { money, toBusinessDate } from '@/lib/format';
import { sum } from '@/domain/money';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { NewAccountForm } from './new-account-form';
import { OwnerMoneyForm } from './owner-money-form';

export const metadata: Metadata = { title: 'Accounts' };
export const dynamic = 'force-dynamic';

const KIND_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MOBILE_MONEY: 'Mobile money',
  BANK: 'Bank',
  OTHER: 'Other',
};

export default async function AccountsPage() {
  const user = await requirePageAccess('accounts', 'view');

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const accounts = listPaymentAccounts(db, true);
  const active = accounts.filter((account) => account.isActive);
  const totalHeld = sum(active.map((account) => account.balance));
  const trial = getTrialBalance(db);
  const negative = active.filter((account) => account.balance < 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Accounts"
        description="Every pot of money the shop holds — cash, mobile money, bank."
      />

      {!trial.balanced && (
        <Alert tone="danger" title="The books do not balance" className="mb-4">
          Total debits ({money(trial.totalDebit)}) do not equal total credits (
          {money(trial.totalCredit)}). Please report this before recording anything else.
        </Alert>
      )}

      {negative.length > 0 && (
        <Alert tone="warning" title="An account is showing a negative balance" className="mb-4">
          {negative.map((account) => account.name).join(', ')} shows less than zero. That usually
          means a payment was recorded from the wrong account, or money went in without being
          recorded. Check the movements before trusting the figure.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Stat
          label="Total money held" icon="accounts"
          value={money(totalHeld, { currencyCode: currency })}
          hint="Across all active accounts"
        />
        <Stat label="Accounts" icon="accounts" value={String(active.length)} />
      </div>

      {accounts.length === 0 ? (
        <div className="mb-6">
          <EmptyState
            title="No money accounts yet"
            description="Add the places money actually sits — cash in the drawer, a mobile money wallet, a bank account. Every payment has to land somewhere."
          />
        </div>
      ) : (
      <TableWrap className="mb-6">
        <THead>
          <TH>Account</TH>
          <TH>Type</TH>
          <TH>Provider</TH>
          <TH numeric>Balance</TH>
          <TH />
        </THead>
        <tbody>
          {accounts.map((account) => (
            <TR key={account.id}>
              <TD>
                <Link
                  href={`/accounts/${account.id}`}
                  className="font-medium text-accent hover:underline"
                >
                  {account.name}
                </Link>
                {account.isDefault && (
                  <Badge tone="accent" className="ml-2">
                    Default
                  </Badge>
                )}
                {!account.isActive && (
                  <Badge tone="neutral" className="ml-2">
                    Archived
                  </Badge>
                )}
                <div className="mt-0.5 text-xs text-content-subtle">
                  Ledger account {account.glCode}
                  {account.accountNumber ? ` · ${account.accountNumber}` : ''}
                </div>
              </TD>
              <TD>
                <span className="text-content-muted">
                  {KIND_LABELS[account.kind] ?? account.kind}
                </span>
              </TD>
              <TD>
                <span className="text-content-muted">{account.provider ?? '—'}</span>
              </TD>
              <TD numeric>
                <span className={account.balance < 0 ? 'font-medium text-danger' : ''}>
                  {money(account.balance, { bare: true })}
                </span>
              </TD>
              <TD>
                <div className="flex justify-end">
                  <Link
                    href={`/accounts/${account.id}`}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Movements
                  </Link>
                </div>
              </TD>
            </TR>
          ))}
        </tbody>
      </TableWrap>
      )}

      {can(user, 'accounts', 'create') && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <NewAccountForm />
          </div>
          <OwnerMoneyForm
            accounts={active.map((account) => ({
              id: account.id,
              name: account.name,
              isDefault: account.isDefault,
            }))}
            today={toBusinessDate()}
            currencyCode={currency}
          />
        </div>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Balances are calculated from the ledger every time this page loads — no total is stored
        anywhere. Open an account to see exactly which transactions produced its balance.
      </p>
    </div>
  );
}
