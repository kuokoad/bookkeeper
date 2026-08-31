import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { visible, type FeatureKey } from '@/lib/business-type';
import { getFeatures } from '@/lib/business-type.server';
import { getProfitAndLoss, getBalanceSheet } from '@/services/reporting/financial.service';
import { money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader, Stat } from '@/components/ui/page';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

/**
 * A `feature` here hides the CARD only. The report behind it is unchanged, its
 * figures are unchanged, and its address still opens. Nothing in this list has
 * one yet — the wiring is here so the next feature does not have to remember
 * that this hand-written list exists.
 */
const REPORTS: {
  group: string;
  items: { href: string; title: string; description: string; feature?: FeatureKey }[];
}[] = [
  {
    group: 'For your accountant',
    items: [
      {
        href: '/reports/year-end',
        title: 'Year-end pack',
        description:
          'A full set of statements for one financial year, with last year alongside. Print it or send the file.',
      },
    ],
  },
  {
    group: 'Money',
    items: [
      {
        href: '/reports/profit-and-loss',
        title: 'Profit & Loss',
        description: 'What you earned, what it cost, and what is left.',
      },
      {
        href: '/reports/balance-sheet',
        title: 'Balance sheet',
        description: 'What the business owns, owes, and is worth.',
      },
      {
        href: '/reports/cash-flow',
        title: 'Cash flow',
        description: 'Where money came in and where it went out.',
      },
    ],
  },
  {
    group: 'Trading',
    items: [
      {
        href: '/reports/sales',
        title: 'Sales report',
        description: 'By day, product, category, customer and payment method.',
      },
      {
        href: '/reports/purchases',
        title: 'Purchase report',
        description: 'By day, supplier and product.',
      },
      {
        href: '/reports/inventory',
        title: 'Inventory report',
        description: 'Stock valuation, movement, low stock and out of stock.',
      },
      {
        href: '/reports/tax',
        title: 'Tax return',
        description: 'What you charged, what you can reclaim, and what you owe.',
      },
    ],
  },
  {
    group: 'Money owed',
    items: [
      {
        href: '/accounting/receivables',
        title: 'Who owes you',
        description: 'Customer debts by age.',
      },
      {
        href: '/accounting/payables',
        title: 'Who you owe',
        description: 'Supplier balances by age.',
      },
    ],
  },
];

export default async function ReportsPage() {
  await requirePageAccess('reports', 'view');

  const features = getFeatures();
  const groups = REPORTS.map((section) => ({
    ...section,
    items: visible(section.items, features),
  })).filter((section) => section.items.length > 0);

  const today = toBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const pl = getProfitAndLoss(db, { from: monthStart, to: today });
  const sheet = getBalanceSheet(db, today);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Reports"
        description="Every figure here is calculated from your actual records, not stored anywhere."
      />

      {!sheet.balances && (
        <Alert tone="danger" title="The balance sheet does not balance" className="mb-6">
          Assets {money(sheet.totalAssets)} do not equal liabilities plus equity{' '}
          {money(sheet.totalLiabilitiesAndEquity)}. Please report this before relying on these
          reports.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon="sales" label="Sales this month" value={money(pl.netSales)} />
        <Stat
          icon="profit"
          label="Profit this month"
          value={money(pl.netProfit)}
          tone={pl.netProfit < 0 ? 'danger' : 'success'}
          hint="After all costs"
        />
        <Stat icon="inventory" label="Stock value" value={money(sheet.inventory)} />
        <Stat icon="books" label="Business worth" value={money(sheet.totalEquity)} hint="Assets less what you owe" />
      </div>

      <div className="space-y-6">
        {groups.map((section) => (
          <section key={section.group}>
            <h2 className="mb-3 text-sm font-semibold text-content">{section.group}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {section.items.map((report) => (
                <Link key={report.href} href={report.href} className="block">
                  <Card className="h-full transition-colors hover:bg-surface-sunken">
                    <p className="font-medium text-accent">{report.title}</p>
                    <p className="mt-1 text-sm text-content-muted">{report.description}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-6 text-xs text-content-subtle">
        Every report can be filtered by date, downloaded as a spreadsheet, and printed.
      </p>
    </div>
  );
}
