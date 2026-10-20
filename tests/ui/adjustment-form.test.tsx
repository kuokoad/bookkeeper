// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Value: protects=each stock-adjustment line's remove control is announced as
 * "Remove line N" and removes that line; fails_when=the aria-label is dropped now
 * the visible text is a bare "✕", or the control stops removing its own line;
 * why_new=no rendered test of the adjustment form existed; seam=none;
 * no_claim=the button's size or position, or saving the adjustment.
 */

vi.mock('@/actions/inventory.actions', () => ({
  createAdjustmentAction: async () => ({}),
}));

const { AdjustmentForm } = await import('@/app/(app)/inventory/adjustments/new/adjustment-form');

afterEach(cleanup);

describe('removing a line from a stock adjustment', () => {
  it('is reachable by name and takes away only the line it belongs to', () => {
    render(
      <AdjustmentForm
        products={[
          { id: 1, name: 'Rice 5kg', unit: 'bag', altUnit: null, altFactorMilli: null, qtyOnHandLabel: '4 bag', expiredBatches: [] },
        ]}
        reasons={[{ value: 'COUNT_CORRECTION', label: 'Count correction', defaultDirection: null }]}
        today="2026-08-26"
        currencyCode="GHS"
      />,
    );

    // A single line cannot be removed: there would be nothing left to save.
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: /add another product/i }));
    expect(screen.getByRole('button', { name: 'Remove line 2' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));

    expect(screen.queryByRole('button', { name: 'Remove line 2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toHaveProperty('disabled', true);
  });
});
