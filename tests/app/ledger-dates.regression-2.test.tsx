import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Same setup as regression-1: the client filter controls read the junk from the
// address bar, and the page has to win over it.
const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => navigation.params, usePathname: () => '/', notFound: vi.fn() }));
const ledger = vi.hoisted(() => ({
  getPayablesAgeing: vi.fn(() => []),
  getReceivablesAgeing: vi.fn(() => []),
  getGeneralLedger: vi.fn(() => ({
    account: { id: 1, code: '1000', name: 'Cash', type: 'ASSET' },
    lines: [], openingBalance: 0, closingBalance: 0, totalDebit: 0, totalCredit: 0,
  })),
}));
const audit = vi.hoisted(() => ({ countAuditLogs: vi.fn(() => 0), listAuditLogs: vi.fn(() => []), listAuditEntityTypes: vi.fn(() => ['journal_entry']) }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/auth/current-user', () => ({ requirePageAccess: vi.fn(async () => ({ role: 'OWNER', permissions: {} })) }));
vi.mock('@/services/reporting/ledger.service', () => ledger);
vi.mock('@/services/reporting/balances.service', () => ({ getAccountBalanceByCode: () => 0 }));
vi.mock('@/services/supplier.service', () => ({ getTotalPayables: () => 0, listSuppliers: () => [] }));
vi.mock('@/services/customer.service', () => ({ getTotalReceivables: () => 0, listCustomers: () => [] }));
vi.mock('@/services/audit.service', () => audit);
vi.mock('@/services/user.service', () => ({ listUsers: () => [{ id: 3, displayName: 'Ama Mensah' }] }));
vi.mock('@/lib/format', async (actual) => ({ ...(await actual<typeof import('@/lib/format')>()), toBusinessDate: () => '2026-10-14' }));
import PayablesPage from '@/app/(app)/accounting/payables/page';
import ReceivablesPage from '@/app/(app)/accounting/receivables/page';
import AuditLogPage from '@/app/(app)/users/audit/page';
import GeneralLedgerPage from '@/app/(app)/accounting/ledger/[id]/page';

async function render(page: Promise<React.ReactElement>, params: Record<string, string>) {
  navigation.params = new URLSearchParams(params);
  return renderToStaticMarkup(await page);
}

// Regression: compact filters echoed a hand-edited date on payables, receivables,
// the audit log and an account's ledger while the data under them used another.
describe('the rest of the date filters given a date nobody meant', () => {
  it.each([
    ['payables', PayablesPage, ledger.getPayablesAgeing],
    ['receivables', ReceivablesPage, ledger.getReceivablesAgeing],
  ] as const)('%s fall back to today and say so', async (_, Page, ageing) => {
    const params = { asAt: 'x' };
    const html = await render(Page({ searchParams: Promise.resolve(params) }), params);
    expect(ageing).toHaveBeenLastCalledWith({}, '2026-10-14');
    expect(html).toContain('value="2026-10-14"');
    expect(html).not.toContain('value="x"');
    expect(html).not.toContain('As at: x');
  });

  it('audit log ignores junk dates in the query, the controls and the chips', async () => {
    const params = { from: 'x', to: '2026-99-99' };
    const html = await render(AuditLogPage({ searchParams: Promise.resolve(params) }), params);
    expect(audit.countAuditLogs).toHaveBeenLastCalledWith({}, {});
    expect(html).not.toContain('value="x"');
    expect(html).not.toContain('value="2026-99-99"');
    expect(html).not.toContain('From: x');
    expect(html).not.toContain('To: 2026-99-99');
  });

  it('audit log names the person it filtered on, and ignores a person id nobody meant', async () => {
    let params: Record<string, string> = { user: '3' };
    let html = await render(AuditLogPage({ searchParams: Promise.resolve(params) }), params);
    expect(audit.countAuditLogs).toHaveBeenLastCalledWith({}, { userId: 3 });
    expect(html).toContain('Person: Ama Mensah');
    expect(html).not.toContain('Person: 3');

    params = { user: 'abc' };
    html = await render(AuditLogPage({ searchParams: Promise.resolve(params) }), params);
    expect(audit.countAuditLogs).toHaveBeenLastCalledWith({}, {});
    expect(html).not.toContain('Person:');
  });

  it('audit log names the action and kind of record it filtered on, and ignores ones nobody meant', async () => {
    let params: Record<string, string> = { action: 'VOID', entity: 'journal_entry' };
    let html = await render(AuditLogPage({ searchParams: Promise.resolve(params) }), params);
    expect(audit.countAuditLogs).toHaveBeenLastCalledWith({}, { action: 'VOID', entityType: 'journal_entry' });
    expect(html).toContain('Action: Voided');
    expect(html).toContain('Kind of record: journal entry');

    params = { action: 'NOPE', entity: 'junk' };
    html = await render(AuditLogPage({ searchParams: Promise.resolve(params) }), params);
    expect(audit.countAuditLogs).toHaveBeenLastCalledWith({}, {});
    expect(html).not.toContain('Action:');
    expect(html).not.toContain('Kind of record:');
  });

  it('account ledger runs all time to today instead of a 500', async () => {
    const params = { from: 'x', to: 'nope' };
    const html = await render(GeneralLedgerPage({ params: Promise.resolve({ id: '1' }), searchParams: Promise.resolve(params) }), params);
    expect(ledger.getGeneralLedger).toHaveBeenLastCalledWith({}, 1, {});
    expect(html).toContain('value="2026-10-14"');
    expect(html).not.toContain('value="x"');
    expect(html).not.toContain('value="nope"');
    expect(html).not.toContain('From: x');
    expect(html).not.toContain('To: nope');
  });
});
