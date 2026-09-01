import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { visible, type FeatureKey } from '@/lib/business-type';
import { getFeatures } from '@/lib/business-type.server';
import { can } from '@/lib/auth/permissions';
import { checkBooksIntegrity } from '@/services/reporting/ledger.service';
import { getTotalReceivables } from '@/services/customer.service';
import { getTotalPayables } from '@/services/supplier.service';
import { getLockStatus } from '@/services/period-lock.service';
import { money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader, Stat } from '@/components/ui/page';
import { BooksLockForm } from './books-lock-form';
import { YearEndForm, type YearOption } from './year-end-form';
import { availableFinancialYears } from '@/services/reporting/year-end.service';
import { isYearClosed } from '@/services/year-end-close.service';

export const metadata: Metadata = { title: 'Accounting' };
export const dynamic = 'force-dynamic';

/** As on the Reports index: a `feature` here hides the card, nothing else. */
const SECTIONS: {
  href: string;
  title: string;
  description: string;
  feature?: FeatureKey;
}[] = [
  {
    href: '/reconciliation',
    title: 'Reconciliation',
    description: 'Count the cash, mobile money and bank against what the books say.',
  },
  {
    href: '/accounting/journal',
    title: 'Journal',
    description: 'Every accounting entry the shop has ever made, newest first.',
  },
  {
    href: '/accounting/chart',
    title: 'Chart of accounts',
    description: 'The accounts the books are kept in, with their balances.',
  },
  {
    href: '/accounting/trial-balance',
    title: 'Trial balance',
    description: 'Proof that total debits equal total credits.',
  },
  {
    href: '/accounting/receivables',
    title: 'Who owes you',
    description: 'Customer debts by how long they have been outstanding.',
  },
  {
    href: '/accounting/payables',
    title: 'Who you owe',
    description: 'Supplier balances by how long they have been outstanding.',
  },
];

export default async function AccountingPage() {
  const user = await requirePageAccess('accounts', 'view');
  const sections = visible(SECTIONS, getFeatures());

  const today = toBusinessDate();
  const yearOptions: YearOption[] = availableFinancialYears(db).map((year) => ({
    startYear: year.startYear,
    label: year.label,
    end: year.end,
    closed: isYearClosed(db, year.startYear),
    finished: today > year.end,
  }));

  const integrity = checkBooksIntegrity(db);
  const receivables = getTotalReceivables(db);
  const payables = getTotalPayables(db);
  const lock = getLockStatus(db);

  const problems: string[] = [];
  if (!integrity.trialBalanced) problems.push('total debits do not equal total credits');
  if (integrity.unbalancedEntries.length > 0) {
    problems.push(`${integrity.unbalancedEntries.length} entry/entries do not balance`);
  }
  if (!integrity.receivablesMatch) problems.push('customer balances do not match the A/R account');
  if (!integrity.payablesMatch) problems.push('supplier balances do not match the A/P account');
  if (integrity.untracedEntries > 0) {
    problems.push(`${integrity.untracedEntries} entry/entries cannot be traced to a transaction`);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Accounting"
        description="The books underneath everything else — and the proof that they add up."
      />

      {problems.length > 0 ? (
        <Alert tone="danger" title="Something is wrong with the books" className="mb-6">
          <ul className="mt-1 list-inside list-disc">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <p className="mt-2">
            Every one of these should be impossible. Please report it before recording anything
            else.
          </p>
        </Alert>
      ) : (
        <Alert tone="success" title="The books are healthy" className="mb-6">
          Debits equal credits, every entry balances on its own, customer and supplier balances
          agree with their control accounts, and every entry traces back to a real transaction.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          icon="books"
          label="Total debits"
          value={money(integrity.totalDebit)}
          hint={`= credits ${money(integrity.totalCredit, { bare: true })}`}
        />
        <Stat
          icon="owed"
          label="Customers owe you"
          value={money(receivables)}
          tone={receivables > 0 ? 'warning' : 'default'}
        />
        <Stat
          icon="owes"
          label="You owe suppliers"
          value={money(payables)}
          tone={payables > 0 ? 'warning' : 'default'}
        />
      </div>

      {can(user, 'settings', 'edit') && (
        <div className="mb-6 space-y-4">
          <YearEndForm years={yearOptions} />
          <BooksLockForm
            lockedBefore={lock.lockedBefore}
            entriesLocked={lock.entriesLocked}
            today={toBusinessDate()}
          />
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={section.href} className="block">
            <Card className="h-full transition-colors hover:bg-surface-sunken">
              <p className="font-medium text-accent">{section.title}</p>
              <p className="mt-1 text-sm text-content-muted">{section.description}</p>
            </Card>
          </Link>
        ))}
      </div>

      <p className="mt-6 text-xs text-content-subtle">
        Nothing on these pages is stored. Every figure is calculated from the same accounting
        entries that each sale, purchase, payment and expense writes, so what you see here is what
        actually happened.
      </p>
    </div>
  );
}
