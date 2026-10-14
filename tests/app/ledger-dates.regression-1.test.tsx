import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const ledger = vi.hoisted(() => ({ listJournalEntries: vi.fn(() => []), getChartOfAccounts: vi.fn(() => []) }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/auth/current-user', () => ({ requirePageAccess: vi.fn(async () => ({ role: 'OWNER', permissions: {} })) }));
vi.mock('@/services/reporting/ledger.service', () => ledger);
vi.mock('@/lib/format', async (actual) => ({ ...(await actual<typeof import('@/lib/format')>()), toBusinessDate: () => '2026-10-14' }));
import JournalPage from '@/app/(app)/accounting/journal/page';
import TrialBalancePage from '@/app/(app)/accounting/trial-balance/page';

// Regression: ISSUE-002 — a hand-edited date on the journal or trial balance crashed the page
// Found by /qa on 2026-10-14
// Report: .gstack/qa-reports/run-20261014T073500Z/qa-report-localhost-2026-10-14.md
// Value: protects=junk dates narrow nothing on ledger pages; fails_when=raw from/to reach formatDate or SQL; why_new=no test renders these pages; seam=none
describe('ledger pages given a date nobody meant', () => {
  it('journal falls back to this month instead of a 500', async () => {
    const html = renderToStaticMarkup(await JournalPage({ searchParams: Promise.resolve({ from: 'x', to: '2026-99-99' }) }));
    expect(ledger.listJournalEntries).toHaveBeenLastCalledWith({}, expect.objectContaining({ from: '2026-10-01', to: '2026-10-14' }));
    // The controls describe what is on screen, not the junk that was typed.
    expect(html).toContain('value="2026-10-01"');
    expect(html).not.toContain('value="x"');
  });

  it('trial balance falls back to today and all time instead of a 500', async () => {
    const html = renderToStaticMarkup(await TrialBalancePage({ searchParams: Promise.resolve({ from: 'nope', to: 'x' }) }));
    expect(ledger.getChartOfAccounts).toHaveBeenLastCalledWith({}, { to: '2026-10-14' });
    expect(html).not.toContain('value="x"');
  });
});
