// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@/actions/cashbook.actions', () => ({ updatePaymentAccountAction: vi.fn(async () => ({})) }));
import { EditAccountForm } from '@/app/(app)/accounts/edit-account-form';

afterEach(cleanup);
const account = { id: 4, name: 'Wallet', provider: 'MTN', kind: 'MOBILE_MONEY', accountNumber: '0240000000', isDefault: true };

describe('account metadata editor', () => {
  it('opens prefilled fields and preserves unrelated account metadata in the submission', () => {
    render(<EditAccountForm account={account} />);
    expect(screen.queryByLabelText('Provider')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit account' }));
    const name = screen.getByLabelText(/Account name/) as HTMLInputElement;
    const provider = screen.getByLabelText('Provider') as HTMLInputElement;
    expect(name.value).toBe('Wallet');
    expect(provider.value).toBe('MTN');
    fireEvent.change(name, { target: { value: 'Shop wallet' } });
    fireEvent.change(provider, { target: { value: 'Telecel' } });
    const data = new FormData(name.form!);
    expect(Object.fromEntries(data)).toEqual({ name: 'Shop wallet', provider: 'Telecel', kind: 'MOBILE_MONEY', accountNumber: '0240000000', isDefault: 'on' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    expect(screen.queryByLabelText('Provider')).toBeNull();
  });
  it('supports empty providers without turning a non-default account into the default', () => {
    render(<EditAccountForm account={{ ...account, provider: null, accountNumber: null, isDefault: false }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit account' }));
    const provider = screen.getByLabelText('Provider') as HTMLInputElement;
    expect(provider.value).toBe('');
    expect(new FormData(provider.form!).has('isDefault')).toBe(false);
  });
});
