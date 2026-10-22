// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PurchaseFormState } from '@/actions/purchase.actions';
import type { TaxComponent } from '@/domain/tax/components';

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

const PRODUCT_IDS = {
  'Evaporated Milk': '1',
  'Rice 5kg': '2',
  'Sugar 1kg': '3',
  'Bath soap': '4',
  'Cartage to site': '5',
} as const;

type ProductName = keyof typeof PRODUCT_IDS;

function renderForm({
  taxComponents = [],
  accounts = [{ id: 1, name: 'Cash', isDefault: true }],
  lockedBefore = null,
}: {
  taxComponents?: TaxComponent[];
  accounts?: { id: number; name: string; isDefault: boolean }[];
  lockedBefore?: string | null;
} = {}) {
  return render(
    <PurchaseEntry
      products={[
        { id: 1, name: 'Evaporated Milk', unit: 'tin', altUnit: 'Carton', altFactorMilli: 24_000, costPrice: 300, altCostPrice: 6_600, qtyOnHandMilli: 0, unitDecimals: 0, altUnitDecimals: 0, trackInventory: true },
        { id: 2, name: 'Rice 5kg', unit: 'bag', altUnit: null, altFactorMilli: null, costPrice: 1_000, altCostPrice: null, qtyOnHandMilli: 0, unitDecimals: 3, altUnitDecimals: null, trackInventory: true },
        // Added in a hurry with no cost on file, which is how a 0.00 got pre-filled.
        { id: 3, name: 'Sugar 1kg', unit: 'pack', altUnit: 'Bale', altFactorMilli: 20_000, costPrice: 0, altCostPrice: 0, qtyOnHandMilli: 0, unitDecimals: 0, altUnitDecimals: 0, trackInventory: true },
        // Whole pieces, but a carton may be split to one decimal place.
        { id: 4, name: 'Bath soap', unit: 'Pcs', altUnit: 'Carton', altFactorMilli: 24_000, costPrice: 100, altCostPrice: 2_400, qtyOnHandMilli: 0, unitDecimals: 0, altUnitDecimals: 1, trackInventory: true },
        // A service: bought, never stocked.
        { id: 5, name: 'Cartage to site', unit: 'trip', altUnit: null, altFactorMilli: null, costPrice: 5_000, altCostPrice: null, qtyOnHandMilli: 0, unitDecimals: 0, altUnitDecimals: null, trackInventory: false },
      ]}
      suppliers={[{ id: 1, name: 'Kofi Wholesale', balanceMinor: 0 }]}
      accounts={accounts}
      today="2026-08-26"
      offerExpiry
      currencyCode="GHS"
      taxComponents={taxComponents}
      lockedBefore={lockedBefore}
    />,
  );
}

/** Choose a product on a line (the first by default), which is what reveals the rest. */
function chooseProduct(name: ProductName = 'Evaporated Milk', line = 0) {
  fireEvent.change(screen.getAllByLabelText(/^product$/i)[line]!, { target: { value: PRODUCT_IDS[name] } });
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
    fireEvent.change(screen.getByLabelText(/^cost (each|per)/i), { target: { value: '6.50' } });

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
    fireEvent.change(screen.getByLabelText(/^cost (each|per)/i), { target: { value: '6.50' } });
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
    fireEvent.change(screen.getByLabelText(/^cost (each|per)/i), { target: { value: '6.5.0' } });

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
    fireEvent.change(screen.getByLabelText(/^cost (each|per)/i), { target: { value: '10.00' } });
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

/**
 * The screen agrees with what Save stores.
 *
 * Every figure on the form used to come from its own hand-rolled reading of
 * the boxes, and each disagreed with the server somewhere: a cleared cost box
 * saved stock at no cost, totals counted lines the server refuses, and a box
 * that could not be read counted as nothing. These hold the one rule that
 * replaced them: a figure appears only when Save would store exactly it, and
 * anything the server refuses is marked, says why, and stops Save.
 */

const quantityBox = () => screen.getByLabelText(/quantity/i);
const costBox = () => screen.getByLabelText(/^cost (each|per)/i) as HTMLInputElement;
const discountBox = () => screen.getByLabelText(/^discount$/i);
const saveButton = () => screen.getByRole('button', { name: /save purchase/i }) as HTMLButtonElement;
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const chooseSupplier = () => type(screen.getByLabelText(/supplier/i), '1');
const lineTotal = () => screen.getByText('Line total').parentElement?.textContent ?? '';
/** The figure beside a caption in the totals and payment summaries. */
const figure = (caption: string) => screen.getByText(caption).nextElementSibling?.textContent ?? '';
/** What a red field says about itself: the element its aria-describedby names. */
function reasonFor(box: Element): string | null {
  const id = box.getAttribute('aria-describedby');
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

/** A supplier and one line of 2 tins at the pre-filled 3.00: a purchase Save accepts. */
function readyToSave() {
  renderForm();
  chooseSupplier();
  chooseProduct();
  type(quantityBox(), '2');
  expect(saveButton().disabled).toBe(false);
}

describe('a cost of zero', () => {
  it('a cleared cost box stops Save instead of saving the stock at no cost', () => {
    readyToSave();
    type(costBox(), '');

    expect(costBox().getAttribute('aria-invalid')).toBe('true');
    expect(reasonFor(costBox())).toMatch(/enter what each one cost/i);
    expect(lineTotal()).toContain('—');
    expect(saveButton().disabled).toBe(true);
  });

  it('a product with no cost on file leaves the cost box empty, not a 0.00 that looks typed', () => {
    renderForm();
    chooseSupplier();
    chooseProduct('Sugar 1kg');
    type(quantityBox(), '5');

    expect(costBox().value).toBe('');
    expect(costBox().getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
  });

  it('choosing a bale with no cost on file does not fill in 0.00 either', () => {
    renderForm();
    chooseSupplier();
    chooseProduct('Sugar 1kg');
    type(screen.getByLabelText('Unit'), 'alt');
    type(quantityBox(), '1');

    expect(costBox().value).toBe('');
    expect(saveButton().disabled).toBe(true);
  });

  it('a 0 typed on purpose is free goods: the line says so, and it saves beside something paid for', () => {
    readyToSave();
    type(costBox(), '0');

    expect(costBox().getAttribute('aria-invalid')).toBeNull();
    expect(reasonFor(costBox())).toMatch(/free goods/i);
    expect(lineTotal()).toContain('0.00');

    fireEvent.click(screen.getByRole('button', { name: /add another line/i }));
    chooseProduct('Rice 5kg', 1);
    type(screen.getAllByLabelText(/quantity/i)[1]!, '1');

    // 2 free tins and a bag at 10.00.
    expect(figure('Total')).toBe('GHS 10.00');
    expect(saveButton().disabled).toBe(false);
  });

  it('a purchase of nothing but free goods is refused before Save, as the server refuses it', () => {
    // A purchase worth 0.00 posts no journal lines, and the server refuses an
    // entry with none. The form used to offer "Save purchase — GHS 0.00".
    readyToSave();
    type(costBox(), '0');

    expect(figure('Total')).toBe('—');
    expect(document.getElementById('total-error')?.textContent).toMatch(/comes to 0\.00 cannot be saved/i);
    expect(saveButton().disabled).toBe(true);
    // Save names the real reason, not the free-goods note on the line.
    expect(reasonFor(saveButton())).toMatch(/comes to 0\.00/);
  });

  it('a discount of the whole line is free goods too, and is named as such', () => {
    readyToSave();
    type(discountBox(), '6.00');

    expect(lineTotal()).toContain('0.00');
    expect(reasonFor(costBox())).toMatch(/free goods/i);
  });

  it('a free service line does not claim to change an average cost', () => {
    renderForm();
    chooseProduct('Cartage to site');
    type(quantityBox(), '1');
    type(costBox(), '0');

    expect(reasonFor(costBox())).toMatch(/nothing is charged/i);
    expect(reasonFor(costBox())).not.toMatch(/average cost/i);
  });

  it('the pre-filled cost follows the unit, but a cost somebody typed is kept', () => {
    renderForm();
    chooseProduct();
    expect(costBox().value).toBe('3.00');

    // The catalog's carton cost replaces the catalog's tin cost.
    type(screen.getByLabelText('Unit'), 'alt');
    expect(costBox().value).toBe('66.00');

    // A figure off today's invoice is the person's own, and a unit change keeps it.
    type(costBox(), '70.00');
    type(screen.getByLabelText('Unit'), 'base');
    expect(costBox().value).toBe('70.00');
  });
});

describe('a line the server would refuse', () => {
  it('an oversized line discount stops Save and leaves the totals blank, not counted', () => {
    readyToSave();
    // 2 tins at 3.00 is 6.00, so 10.00 off is more than the line.
    type(discountBox(), '10.00');

    expect(reasonFor(discountBox())).toMatch(/more than the line, 6\.00/);
    expect(lineTotal()).toContain('—');
    expect(figure('Subtotal')).toBe('—');
    expect(figure('Total')).toBe('—');
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).not.toMatch(/\d/);
  });

  it('a line with a quantity and cost but no product is flagged, not figured', () => {
    renderForm();
    chooseSupplier();
    type(quantityBox(), '2');
    type(costBox(), '25.00');

    const product = screen.getByLabelText(/^product$/i);
    expect(product.getAttribute('aria-invalid')).toBe('true');
    expect(reasonFor(product)).toMatch(/choose a product/i);
    // Save would have dropped it, so the screen may not show 50.00 for it.
    expect(lineTotal()).not.toContain('50.00');
    expect(figure('Subtotal')).toBe('—');
    expect(saveButton().disabled).toBe(true);
  });

  it('a discount on a line with no quantity asks for the quantity, not shows -5.00', () => {
    renderForm();
    chooseProduct();
    type(discountBox(), '5.00');

    expect(reasonFor(quantityBox())).toMatch(/enter a quantity/i);
    expect(lineTotal()).not.toContain('-5.00');
    expect(lineTotal()).toContain('—');
  });

  it('a zero quantity is refused on the quantity, not read as a confident 0.00', () => {
    readyToSave();
    type(quantityBox(), '0');
    type(discountBox(), '1.00');

    expect(reasonFor(quantityBox())).toMatch(/greater than zero/i);
    // The discount is not what is wrong, so it is not the field marked red.
    expect(discountBox().getAttribute('aria-invalid')).toBeNull();
    expect(lineTotal()).not.toContain('0.00');
    expect(saveButton().disabled).toBe(true);
  });

  it('a quantity finer than the unit allows is refused before Save, as the server would', () => {
    readyToSave();
    type(quantityBox(), '1.5');

    expect(reasonFor(quantityBox())).toMatch(/tin is counted in whole numbers/i);
    expect(saveButton().disabled).toBe(true);
  });

  it('an unreadable line leaves the totals blank, not at 0.00', () => {
    readyToSave();
    type(costBox(), '6.5.0');

    expect(figure('Subtotal')).toBe('—');
    expect(figure('Total')).toBe('—');
    expect(saveButton().disabled).toBe(true);
  });

  it('a blank extra line is left out without complaint', () => {
    readyToSave();
    fireEvent.click(screen.getByRole('button', { name: /add another line/i }));

    expect(figure('Subtotal')).toBe('6.00');
    expect(saveButton().disabled).toBe(false);
  });
});

describe('the invoice discount and the amount paid', () => {
  it('an unreadable invoice discount stops Save instead of counting as nothing', () => {
    readyToSave();
    const discount = screen.getByLabelText(/invoice discount/i);
    type(discount, '5.0.0');

    expect(discount.getAttribute('aria-invalid')).toBe('true');
    expect(reasonFor(discount)).toMatch(/not a valid amount/i);
    expect(figure('Total')).toBe('—');
    expect(saveButton().disabled).toBe(true);
  });

  it('an invoice discount larger than the lines stops Save instead of clamping the total to 0.00', () => {
    readyToSave();
    const discount = screen.getByLabelText(/invoice discount/i);
    type(discount, '50.00');

    expect(reasonFor(discount)).toMatch(/more than the subtotal, 6\.00/);
    // The lines are still worth what they are worth.
    expect(figure('Subtotal')).toBe('6.00');
    expect(figure('Total')).toBe('—');
    expect(saveButton().disabled).toBe(true);
  });

  it('an unreadable amount paid stops Save instead of counting as nothing', () => {
    readyToSave();
    const paid = screen.getByLabelText(/amount paid now/i);
    type(paid, 'abc');

    expect(paid.getAttribute('aria-invalid')).toBe('true');
    expect(reasonFor(paid)).toMatch(/not a valid amount/i);
    expect(figure('Paid')).toBe('—');
    expect(saveButton().disabled).toBe(true);
  });

  it('a negative amount paid is refused, not quietly dropped', () => {
    // The server skips a payment of zero or less, so -5 would have saved as
    // no payment at all while the screen said something was paid.
    readyToSave();
    const paid = screen.getByLabelText(/amount paid now/i);
    type(paid, '-5');

    expect(reasonFor(paid)).toMatch(/cannot be negative/i);
    expect(saveButton().disabled).toBe(true);
  });

  it('paying more than the total says so at the field', () => {
    readyToSave();
    const paid = screen.getByLabelText(/amount paid now/i);
    type(paid, '7.00');

    expect(reasonFor(paid)).toMatch(/cannot pay more than the purchase total/i);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('commas, read as the server reads them', () => {
  it('refuses "2,50" rather than reading it as 250.00', () => {
    readyToSave();
    type(costBox(), '2,50');

    expect(reasonFor(costBox())).toMatch(/not a valid amount/i);
    expect(lineTotal()).not.toContain('500.00');
    expect(saveButton().disabled).toBe(true);
  });

  it('accepts proper thousands grouping', () => {
    readyToSave();
    type(costBox(), '1,250.00');

    // 2 at 1,250.00.
    expect(lineTotal()).toContain('2,500.00');
    expect(saveButton().disabled).toBe(false);
  });
});

describe('the tax the server adds', () => {
  const VAT: TaxComponent = { code: 'VAT', name: 'VAT', rateBp: 1_500, basis: 'NET', isRecoverable: true };

  it('is in the total, so the screen quotes what is stored and the full amount can be paid', () => {
    renderForm({ taxComponents: [VAT] });
    chooseSupplier();
    chooseProduct('Rice 5kg');
    type(quantityBox(), '10');

    // 10 bags at 10.00 is 100.00, and 15% VAT on top is 115.00.
    expect(figure('Subtotal')).toBe('100.00');
    expect(figure('VAT')).toBe('15.00');
    expect(figure('Total')).toBe('GHS 115.00');
    expect(saveButton().textContent).toContain('115.00');

    fireEvent.click(screen.getByRole('button', { name: /^all$/i }));
    expect(figure('Paid')).toBe('115.00');
    expect(screen.queryByText(/still owed/i)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('a rate the server cannot charge stops Save and says so under the total', () => {
    renderForm({ taxComponents: [{ ...VAT, rateBp: -100 }] });
    chooseSupplier();
    chooseProduct('Rice 5kg');
    type(quantityBox(), '10');

    expect(figure('Total')).toBe('—');
    expect(document.getElementById('total-error')?.textContent).toMatch(/VAT rate cannot be negative/i);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('a red field says why', () => {
  it('points at an error that is on the page, for every field it can mark', () => {
    readyToSave();
    type(costBox(), 'x');
    type(discountBox(), 'y');
    type(screen.getByLabelText(/invoice discount/i), 'z');
    type(screen.getByLabelText(/amount paid now/i), 'w');

    const red = document.querySelectorAll('[aria-invalid="true"]');
    expect(red.length).toBe(4);
    for (const box of red) expect(reasonFor(box)).toBeTruthy();
  });

  it('says why Save is not offered', () => {
    renderForm();
    chooseProduct();
    type(quantityBox(), '1');

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('Choose a supplier.')).toBeDefined();
  });
});

describe('which cost the box holds', () => {
  it('a pre-filled cost follows a change of product and never carries the old one over', () => {
    // Before, the first product's pre-filled cost stayed: choose Milk, switch
    // to Rice, and Rice was saved at Milk's 3.00.
    renderForm();
    chooseProduct('Evaporated Milk');
    expect(costBox().value).toBe('3.00');
    chooseProduct('Rice 5kg');
    expect(costBox().value).toBe('10.00');
    chooseProduct('Sugar 1kg');
    expect(costBox().value).toBe('');
    chooseProduct('Rice 5kg');
    expect(costBox().value).toBe('10.00');
  });

  it('a cost somebody typed survives a change of product, and the line asks for it to be checked', () => {
    // Kept without a word, Milk's 70.00 a carton became Rice's 70.00 a bag.
    renderForm();
    chooseProduct('Evaporated Milk');
    type(costBox(), '3.20');
    chooseProduct('Rice 5kg');
    expect(costBox().value).toBe('3.20');
    expect(reasonFor(costBox())).toMatch(/typed for Evaporated Milk/);

    // Retyped for this product, it is the person's figure for it.
    type(costBox(), '9.80');
    expect(costBox().getAttribute('aria-describedby')).toBeNull();
  });

  it('a cost typed before the product is chosen is kept when it is chosen', () => {
    renderForm();
    type(costBox(), '25.00');
    chooseProduct('Evaporated Milk');
    expect(costBox().value).toBe('25.00');
  });

  it('a cleared cost box is filled again by a change of unit', () => {
    renderForm();
    chooseProduct('Evaporated Milk');
    type(costBox(), '');
    type(screen.getByLabelText('Unit'), 'alt');
    expect(costBox().value).toBe('66.00');
  });

  it('names the unit the cost is per, and flags a typed cost the unit changed under', () => {
    // 3.20 typed for a tin, then the line switched to cartons: without a word,
    // that read as 3.20 a carton of 24, and the stock came in at 0.13 a tin.
    readyToSave();
    expect(screen.getByLabelText(/^cost per tin$/i)).toBeDefined();
    type(costBox(), '3.20');
    type(screen.getByLabelText('Unit'), 'alt');

    expect(screen.getByLabelText(/^cost per carton$/i)).toBeDefined();
    expect(costBox().value).toBe('3.20');
    expect(reasonFor(costBox())).toMatch(/typed per tin, and the line is now per Carton/i);

    // Back in the unit it was typed in, there is nothing to check.
    type(screen.getByLabelText('Unit'), 'base');
    expect(costBox().getAttribute('aria-describedby')).toBeNull();
  });
});

describe('what Save sends', () => {
  it('sends the cost as shown, leaves out a blank line, and starts afresh once saved', async () => {
    let basket: { items: Record<string, unknown>[] } | undefined;
    action.current = async (formData) => {
      basket = JSON.parse(String(formData?.get('basket')));
      return { purchaseNo: 'PUR-00042', purchaseId: 42 };
    };
    readyToSave();
    fireEvent.click(screen.getByRole('button', { name: /add another line/i }));
    fireEvent.submit(saveButton().closest('form')!);

    expect(await screen.findByText(/PUR-00042/)).toBeDefined();
    expect(basket?.items).toEqual([expect.objectContaining({ productId: 1, qty: '2', unitCost: '3.00' })]);
    // A fresh line, with nothing carried over from the one just saved.
    expect(screen.getAllByLabelText(/^product$/i)).toHaveLength(1);
    expect(costBox().value).toBe('');
  });

  it('sends a typed 0 as 0 and a carton line as a carton line', async () => {
    let basket: { items: Record<string, unknown>[] } | undefined;
    action.current = async (formData) => {
      basket = JSON.parse(String(formData?.get('basket')));
      return {};
    };
    readyToSave();
    type(costBox(), '0');
    fireEvent.click(screen.getByRole('button', { name: /add another line/i }));
    chooseProduct('Bath soap', 1);
    type(screen.getAllByLabelText('Unit')[1]!, 'alt');
    type(screen.getAllByLabelText(/quantity/i)[1]!, '2');
    fireEvent.submit(saveButton().closest('form')!);

    await vi.waitFor(() => expect(basket).toBeDefined());
    expect(basket!.items).toEqual([
      expect.objectContaining({ productId: 1, qty: '2', unitCost: '0' }),
      expect.objectContaining({ productId: 4, qty: '2', unitCost: '24.00', alt: true }),
    ]);
  });

  it('cannot be pressed again while the first save is still running', async () => {
    // A second press that got through would record the delivery twice:
    // double the stock and double what is owed.
    let finish!: (state: PurchaseFormState) => void;
    let calls = 0;
    action.current = () => {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    readyToSave();
    await act(async () => {
      fireEvent.submit(saveButton().closest('form')!);
    });

    const saving = screen.getByRole('button', { name: /saving/i }) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(saving);
    });
    await act(async () => {
      finish({ purchaseNo: 'PUR-00043', purchaseId: 43 });
    });
    expect(calls).toBe(1);
  });
});

describe('the rest of what the server refuses', () => {
  it('a carton must convert to whole pieces, and keep to its own decimal places', () => {
    renderForm();
    chooseSupplier();
    chooseProduct('Bath soap');
    type(screen.getByLabelText('Unit'), 'alt');

    type(quantityBox(), '0.5');
    expect(saveButton().disabled).toBe(false);

    // A tenth of a carton of 24 is 2.4 pieces.
    type(quantityBox(), '0.1');
    expect(reasonFor(quantityBox())).toMatch(/Pcs is counted in whole numbers/);

    type(quantityBox(), '1.25');
    expect(reasonFor(quantityBox())).toMatch(/Carton allows at most 1 decimal place/);
    expect(saveButton().disabled).toBe(true);
  });

  it('a negative discount is refused, not added to the total', () => {
    readyToSave();
    type(discountBox(), '-1.00');
    expect(reasonFor(discountBox())).toMatch(/cannot be negative/i);
    expect(figure('Subtotal')).toBe('—');

    type(discountBox(), '');
    const invoice = screen.getByLabelText(/invoice discount/i);
    type(invoice, '(1.00)');
    expect(reasonFor(invoice)).toMatch(/cannot be negative/i);
    expect(saveButton().disabled).toBe(true);
  });

  it('a payment with no account to come out of is refused, not dropped', () => {
    // With no account the basket sends no payment, and the server would save
    // the purchase as owed in full while the screen showed it paid.
    renderForm({ accounts: [] });
    chooseSupplier();
    chooseProduct();
    type(quantityBox(), '2');
    const paid = screen.getByLabelText(/amount paid now/i);
    type(paid, '1.00');

    expect(reasonFor(paid)).toMatch(/add a payment account/i);
    expect(saveButton().disabled).toBe(true);
  });

  it('a delivery dated inside the books lock is refused before Save, with the server’s reason', () => {
    renderForm({ lockedBefore: '2026-08-31' });
    chooseSupplier();
    chooseProduct();
    type(quantityBox(), '2');

    expect(screen.getByText(/books are closed up to/i)).toBeDefined();
    expect(reasonFor(screen.getByLabelText('Delivery date day'))).toMatch(/books are closed up to/i);
    expect(saveButton().disabled).toBe(true);

    fillDate('Delivery date', '2026-09-01');
    expect(screen.queryByText(/books are closed up to/i)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('flags an invoice number or reference longer than the server keeps, rather than cutting it', () => {
    // Cut short by the box, a pasted invoice number would be saved without a
    // word and no longer match the paper; refused by the server, it said why.
    readyToSave();
    const invoiceNo = screen.getByLabelText(/their invoice no/i);
    type(invoiceNo, 'N'.repeat(61));
    expect(reasonFor(invoiceNo)).toMatch(/keep this to 60 characters/i);
    expect(saveButton().disabled).toBe(true);

    type(invoiceNo, 'N'.repeat(60));
    type(screen.getByLabelText(/amount paid now/i), '1.00');
    const reference = screen.getByLabelText(/^reference$/i);
    type(reference, 'R'.repeat(81));
    expect(reasonFor(reference)).toMatch(/keep this to 80 characters/i);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('what the totals show while they cannot be worked out', () => {
  const VAT: TaxComponent = { code: 'VAT', name: 'VAT', rateBp: 1_500, basis: 'NET', isRecoverable: true };

  it('keeps each tax row, with a dash, rather than letting it vanish', () => {
    renderForm({ taxComponents: [VAT] });
    chooseSupplier();
    chooseProduct('Rice 5kg');
    type(quantityBox(), '10');
    expect(figure('VAT')).toBe('15.00');

    type(quantityBox(), '1.2.3');
    expect(figure('VAT')).toBe('—');
    expect(figure('Total')).toBe('—');
  });

  it('says why the total is missing outside the list of figures', () => {
    // A <p> inside a <dl> is invalid, and screen readers miscount the pairs.
    renderForm({ taxComponents: [{ ...VAT, rateBp: -100 }] });
    chooseSupplier();
    chooseProduct('Rice 5kg');
    type(quantityBox(), '10');

    const reason = document.getElementById('total-error');
    expect(reason?.textContent).toMatch(/VAT rate cannot be negative/i);
    expect(reason?.closest('dl')).toBeNull();
  });

  it('shows no total for an empty form, since there is no purchase yet to save', () => {
    renderForm();
    expect(figure('Subtotal')).toBe('—');
    expect(figure('Total')).toBe('—');
    expect(saveButton().textContent).toBe('Save purchase');
  });

  it('ties the reason Save is not offered to the button itself', () => {
    renderForm();
    expect(reasonFor(saveButton())).toBe('Choose a supplier.');
  });
});
