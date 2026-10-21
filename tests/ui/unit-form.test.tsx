// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Value: protects=a unit row states how many products use it ("1 product",
 * "4 products") and offers Delete only when no product uses it, and the new-unit
 * form offers "Add unit" with no Delete; fails_when=the pluralisation breaks, a
 * unit in use offers Delete, or the add form grows a Delete; why_new=no rendered
 * test of the unit form existed; seam=none; no_claim=the fixed-width slot or
 * nowrap layout, or what saving/deleting does on the server.
 */

vi.mock('@/actions/catalog.actions', () => ({
  saveUnitAction: async () => ({}),
  deleteUnitAction: async () => ({}),
}));

const { UnitForm } = await import('@/app/(app)/products/units/unit-form');

afterEach(cleanup);

describe('a unit on the units page', () => {
  it('used by one product says "1 product" and cannot be deleted', () => {
    render(<UnitForm unit={{ symbol: 'bag', name: 'Bag', decimalPlaces: 0, productCount: 1 }} />);
    expect(screen.getByText('1 product')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('used by several products says "4 products" and cannot be deleted', () => {
    render(<UnitForm unit={{ symbol: 'ctn', name: 'Carton', decimalPlaces: 0, productCount: 4 }} />);
    expect(screen.getByText('4 products')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('used by no product says "0 products" and offers Delete', () => {
    render(<UnitForm unit={{ symbol: 'kg', name: 'Kilogram', decimalPlaces: 3, productCount: 0 }} />);
    expect(screen.getByText('0 products')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
  });

  it('the new-unit form offers "Add unit" and no Delete', () => {
    render(<UnitForm unit={null} />);
    expect(screen.getByRole('button', { name: 'Add unit' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
