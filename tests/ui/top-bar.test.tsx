// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Value: protects=the top bar carries a "Sign out" submit button inside a form,
 * which is the only way out on a phone because the sidebar holding sign-out is
 * hidden there; fails_when=the button is removed from the top bar, stops being a
 * submit, or leaves its form; why_new=no rendered test of the top bar existed;
 * seam=none; no_claim=that it is hidden on desktop (CSS breakpoints), nowrap, or
 * what logoutAction does on the server.
 */

vi.mock('@/actions/auth.actions', () => ({ logoutAction: async () => {} }));
vi.mock('@/actions/theme.actions', () => ({ setThemeAction: async () => {} }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {} }),
}));

const { TopBar } = await import('@/components/shared/top-bar');

afterEach(cleanup);

describe('signing out from the top bar', () => {
  it('offers a Sign out submit button inside a form', () => {
    render(<TopBar shopName="Ama's Provisions" notices={[]} />);
    const button = screen.getByRole('button', { name: 'Sign out' });
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.closest('form')).not.toBeNull();
  });
});
