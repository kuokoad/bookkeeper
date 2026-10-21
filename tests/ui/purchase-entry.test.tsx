// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PurchaseFormState } from '@/actions/purchase.actions';

/**
 * Recording a delivery, rendered.
 *
 * The expiry date on a purchase line is the one field in this application that
 * a person can fill in wrongly and have a till refuse a sale a month later. Two
 * decisions protect against that, and both live in this component rather than
 * in any service, so only a rendered test can hold them:
 *
 *   - the field is HIDDEN until somebody asks for it, because most lines in
 *     most shops are rice and soap and a field that is present gets filled in;
 *   - a date already in the past says so on the spot, where it is still cheap
 *     to fix, rather than at the counter where it becomes a refused sale.
 */

const action = vi.hoisted(() => ({
  current: async (_formData?: FormData): Promise<PurchaseFormState> => ({}),
}));
vi.mock('@/actions/purchase.actions', () => ({
  createPurchaseAction: (_previous: PurchaseFormState, formData: FormData) =>
    action.current(formData),
}));

const { PurchaseEntry } = await import('@/app/(app)/purchases/new/purchase-entry');

function renderForm() {
  return render(
    <PurchaseEntry
      products={[
        { id: 1, name: 'Evaporated Milk', unit: 'tin', altUnit: 'Carton', altFactorMilli: 24_000, costPrice: 300, altCostPrice: 6_600, qtyOnHandMilli: 0 },
        { id: 2, name: 'Rice 5kg', unit: 'bag', altUnit: null, altFactorMilli: null, costPrice: 1_000, altCostPrice: null, qtyOnHandMilli: 0 },
      ]}
      suppliers={[{ id: 1, name: 'Kofi Wholesale', balanceMinor: 0 }]}
      accounts={[{ id: 1, name: 'Cash', isDefault: true }]}
      today="2026-08-26"
      offerExpiry
      currencyCode="GHS"
    />,
  );
}

/** Choose a product on the first line, which is what reveals the rest. */
function chooseProduct(name = 'Evaporated Milk') {
  fireEvent.change(screen.getByLabelText(/^product$/i), {
    target: { value: name === 'Evaporated Milk' ? '1' : '2' },
  });
}

afterEach(() => {
  cleanup();
  action.current = async () => ({});
});

/**
 * Fill a segmented date field.
 *
 * The single `fireEvent.change` that drove `<input type="date">` cannot work
 * here: the field is three boxes now, and setting the day box to a whole date
 * string leaves the other two empty, so no value is ever assembled. The segments
 * announce themselves by what the date IS, which is also what keeps them apart
 * when a page has several.
 */
function fillDate(label: string, value: string) {
  const [year, month, day] = value.split('-');
  fireEvent.change(screen.getByLabelText(`${label} day`), { target: { value: day } });
  fireEvent.change(screen.getByLabelText(`${label} month`), { target: { value: month } });
  fireEvent.change(screen.getByLabelText(`${label} year`), { target: { value: year } });
}

describe('the expiry date on a delivery line', () => {
  it('is not offered at all until a product is chosen', () => {
    renderForm();
    expect(screen.queryByRole('button', { name: /expiry date/i })).toBeNull();
  });

  it('is offered as a link, not a field, so nobody is asked about a bag of rice', () => {
    renderForm();
    chooseProduct();

    expect(screen.getByRole('button', { name: /\+ expiry date/i })).toBeDefined();
    // The input itself is still absent.
    expect(screen.queryByLabelText(/^expires$/i)).toBeNull();
  });

  it('appears once asked for', () => {
    renderForm();
    chooseProduct();
    fireEvent.click(screen.getByRole('button', { name: /\+ expiry date/i }));

    expect(screen.getByLabelText(/^expires$/i)).toBeDefined();
  });

  it('WARNS when the date has already passed', () => {
    /**
     * The mistyped year, caught here rather than at the counter. Goods dated
     * before the day they arrived are expired the moment they are saved, and
     * the till would refuse to sell them — which is how staff learn to sell
     * off-system.
     */
    renderForm();
    chooseProduct();
    fireEvent.click(screen.getByRole('button', { name: /\+ expiry date/i }));
    fillDate('Expires', '2025-03-31');

    expect(screen.getByText(/That date has already passed/i)).toBeDefined();
  });

  it('says nothing about a date in the future', () => {
    renderForm();
    chooseProduct();
    fireEvent.click(screen.getByRole('button', { name: /\+ expiry date/i }));
    fillDate('Expires', '2027-03-31');

    expect(screen.queryByText(/already passed/i)).toBeNull();
  });

  it('treats the delivery date itself as still good', () => {
    // An expiry date is the last day the goods are good, so a batch dated the
    // day it arrived is not expired.
    renderForm();
    chooseProduct();
    fireEvent.click(screen.getByRole('button', { name: /\+ expiry date/i }));
    fillDate('Expires', '2026-08-26');

    expect(screen.queryByText(/already passed/i)).toBeNull();
  });

  it('can be taken away again', () => {
    renderForm();
    chooseProduct();
    fireEvent.click(screen.getByRole('button', { name: /\+ expiry date/i }));
    fillDate('Expires', '2025-01-01');
    expect(screen.getByText(/already passed/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /no date/i }));

    expect(screen.queryByLabelText(/^expires$/i)).toBeNull();
    expect(screen.queryByText(/already passed/i)).toBeNull();
  });
});

describe('what the delivery adds up to', () => {
  it('totals a line from quantity and cost', () => {
    renderForm();
    chooseProduct();
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText(/cost each/i), { target: { value: '6.50' } });

    // 24 at 6.50 is 156.00.
    expect(screen.getAllByText(/156\.00/).length).toBeGreaterThan(0);
  });

  it('shows the line total under its own caption, net of the line discount', () => {
    /**
     * Value: protects=the figure captioned "Line total" is that line's qty*cost - discount;
     * fails_when=the caption drifts off the figure, or the line figure ignores the discount;
     * why_new=the test above matches 156.00 anywhere, so the grand total alone satisfies it;
     * seam=none; no_claim=layout (centring, alignment) or the grand total's arithmetic.
     */
    renderForm();
    chooseProduct();
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText(/cost each/i), { target: { value: '6.50' } });
    fireEvent.change(screen.getByLabelText(/^discount$/i), { target: { value: '5.00' } });

    // 24 at 6.50 is 156.00, less 5.00 off the line.
    expect(screen.getByText('Line total').parentElement?.textContent).toContain('151.00');
  });

  it('shows a dash, not 0.00, when a line figure cannot be read', () => {
    /**
     * Value: protects=an unreadable cost leaves the captioned line total blank (—), never a plausible 0.00;
     * fails_when=the line total falls back to 0 again; why_new=no test covered unreadable input on a line;
     * seam=none; no_claim=what the server does with the bad value.
     */
    renderForm();
    chooseProduct();
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText(/cost each/i), { target: { value: '6.5.0' } });

    const lineTotal = screen.getByText('Line total').parentElement?.textContent ?? '';
    expect(lineTotal).toContain('—');
    expect(lineTotal).not.toContain('0.00');
  });

  it('flags a line discount that is unreadable or larger than the line', () => {
    /**
     * Value: protects=the discount box is marked invalid before Save when the server would refuse it;
     * fails_when=the discount loses its invalid flag; why_new=discount had no invalid state at all;
     * seam=none; no_claim=the server-side refusal itself (purchase.service tests own that).
     */
    renderForm();
    chooseProduct();
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/cost each/i), { target: { value: '10.00' } });
    const discount = screen.getByLabelText(/^discount$/i);

    fireEvent.change(discount, { target: { value: '5.00' } });
    expect(discount.getAttribute('aria-invalid')).toBeNull();

    // 2 at 10.00 is 20.00, so 25.00 off is more than the line.
    fireEvent.change(discount, { target: { value: '25.00' } });
    expect(discount.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(discount, { target: { value: '5.0.0' } });
    expect(discount.getAttribute('aria-invalid')).toBe('true');
  });

  it('will not save without a supplier', () => {
    renderForm();
    chooseProduct();
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '1' } });

    expect(screen.getByRole('button', { name: /save purchase/i })).toHaveProperty('disabled', true);
  });

  it('saves once a supplier and a line are there', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/supplier/i), { target: { value: '1' } });
    chooseProduct();
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '1' } });

    expect(screen.getByRole('button', { name: /save purchase/i })).toHaveProperty('disabled', false);
  });
});
