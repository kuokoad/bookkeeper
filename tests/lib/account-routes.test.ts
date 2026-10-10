import { describe, expect, it } from 'vitest';
import { accountHref, accountIdFromRoute } from '@/lib/account-routes';

describe('account URLs', () => {
  it.each([[1, 'cash'], [2, 'momo'], [3, 'bank']] as const)('maps account %i in both directions', (id, slug) => {
    expect(accountHref(id)).toBe(`/accounts/${slug}`);
    expect(accountIdFromRoute(slug)).toBe(id);
    expect(accountIdFromRoute(String(id))).toBe(id);
  });
  it('keeps additional accounts addressable by ID', () => {
    expect(accountHref(4)).toBe('/accounts/4');
    expect(accountIdFromRoute('4')).toBe(4);
  });
  it.each(['unknown', '0', '-1', '1.5', '1e2', '9007199254740992'])('rejects invalid route %s', value => {
    expect(accountIdFromRoute(value)).toBeUndefined();
  });
});
