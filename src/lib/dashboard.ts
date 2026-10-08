import { addDays } from '@/domain/business-date';
import { add, minor, subtract, sum, type Minor } from '@/domain/money';
import type {
  AgeingRow,
  BooksIntegrity,
} from '@/services/reporting/ledger.service';
import type { AccountReconciliationState } from '@/services/reconciliation.service';

export const DASHBOARD_RANGES = { week: 7, month: 30, quarter: 90 } as const;
export type DashboardRange = keyof typeof DASHBOARD_RANGES;
export function dashboardRange(value?: string): DashboardRange {
  return value === 'week' || value === 'quarter' ? value : 'month';
}
export function dashboardPeriod(today: string, range: DashboardRange) {
  // Preserve the original inclusive dashboard windows (today minus N through today).
  return { from: addDays(today, -DASHBOARD_RANGES[range]), to: today };
}
export function dashboardRangeHref(
  sales: DashboardRange,
  spend: DashboardRange,
) {
  return `/dashboard?sales=${sales}&spend=${spend}`;
}
/** Fill confirmed no-transaction days only after the complete period query succeeds. */
export function dashboardDailySeries(
  rows: { businessDate: string; total: Minor }[],
  period: { from: string; to: string },
) {
  const byDate = new Map(rows.map((row) => [row.businessDate, row.total]));
  const result: { label: string; value: Minor }[] = [];
  for (let date = period.from; date <= period.to; date = addDays(date, 1)) {
    result.push({ label: date.slice(5), value: byDate.get(date) ?? minor(0) });
  }
  return result;
}
export function summariseAgeing(rows: AgeingRow[], ledgerTotal: Minor) {
  const overdue = sum(
    rows.map((row) =>
      sum([row.days1to30, row.days31to60, row.days61to90, row.over90]),
    ),
  );
  const notYetDue = sum(rows.map((row) => row.current));
  const agedTotal = add(overdue, notYetDue);
  // Never invent a due date for opening balances, unallocated payments or credits.
  const unaged = subtract(ledgerTotal, agedTotal);
  return { overdue, notYetDue, agedTotal, unaged, reconciles: unaged === 0 };
}
export function reconciliationIssues(rows: AccountReconciliationState[]) {
  return rows.filter((row) => row.unresolvedDifference !== 0);
}
export function integrityChecks(check: BooksIntegrity) {
  return [
    { label: 'Debits equal credits', passed: check.trialBalanced },
    {
      label: 'Every journal entry balances',
      passed: check.unbalancedEntries.length === 0,
    },
    {
      label: 'Customer balances match control account',
      passed: check.receivablesMatch,
    },
    {
      label: 'Supplier balances match control account',
      passed: check.payablesMatch,
    },
    {
      label: 'Entries have source references',
      passed: check.untracedEntries === 0,
    },
  ];
}
