import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: () => ({ currencyCode: 'GHS' }) }) }) }) } }));
vi.mock('@/lib/auth/current-user', () => ({ requirePageAccess: vi.fn(async () => ({ role: 'STAFF', permissions: {} })) }));
vi.mock('@/services/payment-account.service', () => ({
  getPaymentAccount: () => ({ id: 1, name: 'Cash', balance: 1293400, glCode: '1001' }),
  countAccountMovements: () => 1,
  listAccountSourceTypes: () => ['SALE'],
  getAccountStatement: () => ({ opening: 1305200, moneyIn: 33600, moneyOut: 0, closing: 1338800, total: 1, movements: [{ entryId: 1, entryNo: 'JE-1', entryDate: '2026-10-09', occurredAt: new Date('2026-10-09T12:00:00Z'), sourceType: 'SALE', sourceId: null, memo: 'Sale', description: 'Receipt', inMinor: 33600, outMinor: 0, runningBalance: 1338800 }] }),
}));
vi.mock('@/components/shared/filter-bar', () => ({ FilterBar: () => null }));
vi.mock('@/components/shared/pagination', () => ({ Pagination: () => null }));
import AccountPage from '@/app/(app)/accounts/[id]/page';
import { requirePageAccess } from '@/lib/auth/current-user';

// Regression: ISSUE-001 — filtered subtotals must not claim to be ledger balances.
// Found by /qa on 2026-10-10.
// Report: .gstack/qa-reports/run-20261010T083000Z/qa-report-localhost-2026-10-10.md
// Value: protects=honest account balance labels; fails_when=filtered totals are labelled closing balance; why_new=service tests only verify calculations; seam=none
async function page(query: Record<string, string | undefined>) {
  return renderToStaticMarkup(await AccountPage({ params: Promise.resolve({ id: 'cash' }), searchParams: Promise.resolve(query) }));
}

describe('account filter balance presentation', () => {
  it('hides editing from users without Accounts edit permission', async () => {
    expect(await page({})).not.toContain('Edit account');
  });
  it('offers editing to the owner', async () => {
    vi.mocked(requirePageAccess).mockResolvedValueOnce({ role: 'OWNER', permissions: {} } as Awaited<ReturnType<typeof requirePageAccess>>);
    expect(await page({})).toContain('Edit account');
  });
  it.each([{ type: 'SALE' }, { flow: 'in' }, { q: 'receipt' }, { min: '150' }])('identifies narrowed totals without claiming an actual closing balance: %j', async query => {
    const html = await page(query);
    expect(html).toContain('Filtered closing total');
    expect(html).toContain('Filtered running total');
    expect(html).toContain('13,388.00');
    expect(html).toContain('GHS 12,934.00');
    expect(html).toContain('opening balance plus matching movements');
    expect(html).not.toContain('will not bridge');
    expect(html).not.toContain('This is the full answer');
  });
  it('retains real balance terminology when only the dates are narrowed', async () => {
    const html = await page({ period: 'custom', from: '2026-10-01', to: '2026-10-10' });
    expect(html).toContain('Closing balance');
    expect(html).not.toContain('Filtered closing total');
  });
});
