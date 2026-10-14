import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/lib/auth/current-user', () => ({ requirePermission: vi.fn(async () => ({ id: 1 })) }));
vi.mock('@/lib/http-throttle', () => ({ EXPORT_THROTTLE: {}, throttleOrNull: () => null }));
vi.mock('@/services/payment-account.service', () => ({
  getPaymentAccount: () => ({ id: 1, name: 'Cash' }),
  getAccountStatement: () => ({
    opening: 0, moneyIn: 2779700, moneyOut: 0, closing: 2779700, total: 1,
    movements: [{ entryId: 1, entryNo: 'JE-1', entryDate: '2026-10-13', sourceType: 'INCOME', memo: null, description: 'Income', inMinor: 2779700, outMinor: 0, runningBalance: 2779700 }],
  }),
}));
import { GET } from '@/app/api/exports/[list]/route';

// Regression: ISSUE-003 — a filtered account CSV called its subtotal the closing balance
// Found by /qa on 2026-10-14
// Report: .gstack/qa-reports/run-20261014T073500Z/qa-report-localhost-2026-10-14.md
// Value: protects=downloaded statements never pass a filtered subtotal off as a balance; fails_when=the export labels differ from the screen under a type/flow/search/amount filter; why_new=account-balances.regression-1 covers the screen only; seam=none
async function csv(query: string) {
  const response = await GET(new NextRequest(`http://localhost/api/exports/account?id=1&${query}`), { params: Promise.resolve({ list: 'account' }) });
  return response.text();
}

describe('account statement export', () => {
  it.each(['flow=in', 'type=SALE', 'q=receipt', 'min=10'])('labels narrowed totals as filtered, like the screen: %s', async (query) => {
    const text = await csv(`period=year&${query}`);
    expect(text).toContain('Filtered closing total');
    expect(text).toContain('Filtered running total');
    expect(text).not.toMatch(/^Closing balance,/m);
  });

  it('keeps real balance wording when only the dates are narrowed', async () => {
    const text = await csv('period=year');
    expect(text).toMatch(/^Closing balance,/m);
    expect(text).not.toContain('Filtered');
  });
});
