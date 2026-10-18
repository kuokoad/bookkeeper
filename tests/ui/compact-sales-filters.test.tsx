// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { resolveDateRange, type ActiveFilter } from '@/lib/filters';
import { parseSalesFilters } from '@/lib/list-filters';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), pushed: [] as string[] }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: (url: string) => navigation.pushed.push(url) }), useSearchParams: () => navigation.params }));
vi.mock('@/components/ui/date-field', () => ({ DateField: ({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) =>
  <input id={id} aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }));
const { FilterBar } = await import('@/components/shared/filter-bar');

function bar(active: ActiveFilter[] = []) {
  const { range, preset } = resolveDateRange(navigation.params.get('period') ?? undefined, navigation.params.get('from') ?? undefined, navigation.params.get('to') ?? undefined, '2026-10-09');
  return <FilterBar compactSales basePath="/sales" active={active} dateRange={{ preset, ...range }}
    quick={[
      { label: "Today's sales", params: { period: 'today', from: null, to: null }, match: { period: 'today' } },
      { label: 'Credit sales', params: { paid: 'unpaid' }, match: { paid: 'unpaid' } },
      { label: 'Cash sales', params: { method: 'CASH' }, match: { method: 'CASH' } },
      { label: 'MoMo sales', params: { method: 'MOBILE_MONEY' }, match: { method: 'MOBILE_MONEY' } },
      { label: 'Voided', params: { status: 'VOIDED' }, match: { status: 'VOIDED' } },
    ]}
    fields={[
      { kind: 'search', key: 'q', label: 'Search' },
      ...['customer', 'category', 'product', 'account', 'staff', 'status'].map(key => ({ kind: 'select' as const, key,
        label: key === 'status' ? 'Status' : key, allLabel: 'All', options: key === 'status' ? [{ value: 'POSTED', label: 'Posted' }, { value: 'VOIDED', label: 'Voided' }] : [{ value: '1', label: 'One' }] })),
      { kind: 'amount-range', minKey: 'min', maxKey: 'max', label: 'Total' },
    ]} />;
}
function applied() { return new URLSearchParams(navigation.pushed.at(-1)?.split('?')[1]); }
beforeEach(() => { navigation.params = new URLSearchParams(); navigation.pushed = []; });
afterEach(cleanup);

describe('compact accounting and audit filters', () => {
  it('preserves resolved report date defaults when applying another filter', () => {
    navigation.params = new URLSearchParams('page=3&account=4');
    render(<FilterBar compact basePath="/accounting/journal" fields={[
      { kind: 'date', key: 'from', label: 'From', defaultValue: '2026-10-01' },
      { kind: 'date', key: 'to', label: 'To', defaultValue: '2026-10-18' },
      { kind: 'select', key: 'source', label: 'Kind', allLabel: 'Everything', options: [{ value: 'INCOME', label: 'Other income' }] },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-01');
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-10-18');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'INCOME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    expect(Object.fromEntries(applied())).toEqual({ account: '4', source: 'INCOME', from: '2026-10-01', to: '2026-10-18' });
  });
  it('allows optional dates to be cleared and keeps the as-at query key', () => {
    navigation.params = new URLSearchParams('from=2026-01-01&asAt=2026-10-18');
    render(<FilterBar compact basePath="/reports/balance-sheet" active={[
      { key: 'from', label: 'From', value: '2026-01-01' },
      { key: 'asAt', label: 'As at', value: '2026-10-18' },
    ]} fields={[
      { kind: 'date', key: 'from', label: 'From (optional)', defaultValue: '' },
      { kind: 'date', key: 'asAt', label: 'As at', defaultValue: '2026-10-18' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters (2)' }));
    fireEvent.change(screen.getByLabelText('From (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    expect(applied().has('from')).toBe(false);
    expect(applied().get('asAt')).toBe('2026-10-18');
  });
  it('prefills the selected financial year without changing it when the panel opens', () => {
    render(<FilterBar compact basePath="/reports/year-end" fields={[
      { kind: 'select', key: 'year', label: 'Financial year', allLabel: 'Current financial year', defaultValue: '2025', options: [{ value: '2025', label: '2025/26' }] },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect((screen.getByLabelText('Financial year') as HTMLSelectElement).value).toBe('2025');
    expect(navigation.pushed).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    expect(applied().get('year')).toBe('2025');
  });
});

describe('compact Sales filters', () => {
  it('collapses advanced fields but keeps toolbar visible and preserves drafts on collapse', () => {
    render(bar());
    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByLabelText('Date range')).toBeTruthy();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('customer'), { target: { value: '1' } });
    fireEvent.click(trigger); fireEvent.click(trigger);
    expect((screen.getByLabelText('customer') as HTMLSelectElement).value).toBe('1');
    expect(navigation.pushed).toHaveLength(0);
  });
  it.each(['today', 'yesterday', 'week', 'last-week', 'month', 'last-month', 'year', 'all'])('applies %s without stale custom dates or losing sort', period => {
    navigation.params = new URLSearchParams('period=custom&from=2026-09-01&to=2026-09-30&customer=1&sort=amount&direction=asc&page=3');
    render(bar());
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: period } });
    expect(applied().get('period')).toBe(period);
    expect(applied().has('from')).toBe(false);
    expect(applied().has('to')).toBe(false);
    expect(applied().get('customer')).toBe('1');
    expect(applied().get('sort')).toBe('amount');
    expect(applied().get('direction')).toBe('asc');
    expect(applied().has('page')).toBe(false);
  });
  it('only shows custom dates when selected and submits inclusive boundaries', () => {
    render(bar()); expect(screen.queryByLabelText('From')).toBeNull();
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'custom' } });
    expect(navigation.pushed).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Apply dates' }).closest('form')!);
    expect(parseSalesFilters(Object.fromEntries(applied()), '2026-10-09').range).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });
  it('searches only on submit and resets pagination without clearing other filters', () => {
    navigation.params = new URLSearchParams('customer=1&method=CASH&page=4&created=1&sort=amount');
    render(bar());
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: ' lipstick ' } });
    expect(navigation.pushed).toHaveLength(0);
    fireEvent.submit(screen.getByRole('button', { name: 'Search' }).closest('form')!);
    expect(applied().get('q')).toBe('lipstick'); expect(applied().get('method')).toBe('CASH');
    expect(applied().get('customer')).toBe('1'); expect(applied().has('page')).toBe(false); expect(applied().has('created')).toBe(false);
  });
  it.each([['Credit sales', 'paid', 'unpaid'], ['Cash sales', 'method', 'CASH'], ['MoMo sales', 'method', 'MOBILE_MONEY'], ['Voided', 'status', 'VOIDED']])('preserves the %s definition and compatible filters', (label, key, value) => {
    navigation.params = new URLSearchParams(key === 'paid' ? 'method=CASH&customer=1' : 'paid=unpaid&customer=1');
    render(bar()); fireEvent.click(screen.getByRole('button', { name: label }));
    expect(applied().get(key)).toBe(value); expect(applied().get('customer')).toBe('1');
    if (key !== 'paid') expect(applied().get('paid')).toBe('unpaid');
  });
  it('All Sales clears quick restrictions but preserves explicitly selected advanced Status', () => {
    navigation.params = new URLSearchParams('paid=unpaid&method=CASH&status=VOIDED&customer=1&period=yesterday');
    render(bar()); fireEvent.click(screen.getByRole('button', { name: 'All Sales' }));
    expect(applied().has('paid')).toBe(false); expect(applied().has('method')).toBe(false);
    expect(applied().get('status')).toBe('VOIDED'); expect(applied().get('customer')).toBe('1'); expect(applied().get('period')).toBe('yesterday');
  });
  it('All Sales clears Voided when its source is a quick filter', () => {
    navigation.params = new URLSearchParams('status=VOIDED&statusSource=quick&category=1');
    render(bar()); fireEvent.click(screen.getByRole('button', { name: 'All Sales' }));
    expect(applied().has('status')).toBe(false); expect(applied().has('statusSource')).toBe(false); expect(applied().get('category')).toBe('1');
  });
  it('counts all eight applied advanced fields, excluding search, dates and quick classifications', () => {
    navigation.params = new URLSearchParams('customer=1&category=1&product=1&account=1&staff=1&status=POSTED&min=0&max=100&q=lipstick&period=today&method=CASH&paid=unpaid');
    render(bar(['customer', 'category', 'product', 'account', 'staff', 'status'].map(key => ({ key, label: key, value: 'Selected' }))));
    expect(screen.getByRole('button', { name: 'Filters (8)' })).toBeTruthy();
  });
  it('carries quick Status provenance through sorting and export query construction without changing classification', () => {
    const parsed = parseSalesFilters({ status: 'VOIDED', statusSource: 'quick', method: 'CASH', paid: 'unpaid', sort: 'amount', direction: 'asc' }, '2026-10-09');
    expect(parsed.carried.statusSource).toBe('quick');
    expect(parsed.filters.status).toBe('VOIDED');
    expect(parsed.filters.paymentKind).toBe('CASH');
    expect(parsed.filters.paymentState).toBe('unpaid');
  });
  it('applies combined advanced filters, treats Status as explicit, and counts applied fields', () => {
    navigation.params = new URLSearchParams('customer=1&min=10&max=100&status=VOIDED&statusSource=quick');
    render(bar([{ key: 'customer', label: 'Customer', value: 'One' }, { key: 'min', label: 'Amount', value: '10–100', alsoClears: ['max'] }, { key: 'status', label: 'Status', value: 'Voided' }]));
    fireEvent.click(screen.getByRole('button', { name: 'Filters (3)' }));
    for (const field of ['category', 'product', 'account', 'staff']) fireEvent.change(screen.getByLabelText(field), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'POSTED' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Apply Filters' }).closest('form')!);
    for (const field of ['category', 'product', 'account', 'staff']) expect(applied().get(field)).toBe('1');
    expect(applied().get('status')).toBe('POSTED'); expect(applied().has('statusSource')).toBe(false);
  });
  it('synchronizes Today and restores URL controls after browser history changes', () => {
    const view = render(bar()); fireEvent.click(screen.getByRole('button', { name: "Today's sales" }));
    expect(applied().get('period')).toBe('today');
    navigation.params = new URLSearchParams('period=today&q=mascara'); view.rerender(bar());
    expect(screen.getByRole('button', { name: "Today's sales" }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Date range') as HTMLSelectElement).value).toBe('today');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'unsubmitted' } });
    navigation.params = new URLSearchParams('period=yesterday&q=lipstick'); view.rerender(bar());
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('lipstick');
    expect(screen.getByRole('button', { name: "Today's sales" }).getAttribute('aria-pressed')).toBe('false');
  });
  it('clears to the existing This Month default and removes grouped amount chips', () => {
    navigation.params = new URLSearchParams('min=10&max=100&period=all');
    render(bar([{ key: 'min', label: 'Amount', value: '10–100', alsoClears: ['max'] }]));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amount: 10–100' }));
    expect(applied().has('min')).toBe(false); expect(applied().has('max')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    expect(navigation.pushed.at(-1)).toBe('/sales');
    expect(parseSalesFilters({}, '2026-10-09').preset).toBe('month');
  });
});

describe('compact filters across other modules', () => {
  it.each([
    ['/purchases', 'Credit purchases', 'paid', 'outstanding'],
    ['/purchases', 'Fully paid', 'paid', 'paid'],
    ['/purchases', 'Partly paid', 'paid', 'partial'],
    ['/expenses', "Today's expenses", 'period', 'today'],
    ['/inventory', 'Sales', 'movement', 'SALE'],
    ['/inventory', 'Purchases', 'movement', 'PURCHASE'],
    ['/inventory', 'Customer returns', 'movement', 'SALE_RETURN'],
    ['/inventory', 'Adjustments out', 'movement', 'ADJUSTMENT_OUT'],
    ['/reports/inventory', 'Low stock', 'stock', 'low'],
    ['/reports/inventory', 'Out of stock', 'stock', 'out'],
  ])('preserves %s quick-filter meaning for %s', (basePath, label, key, val) => {
    navigation.params = new URLSearchParams('category=1&sort=amount&page=3');
    render(<FilterBar compact basePath={basePath} dateRange={{ preset: 'month', from: '2026-10-01', to: '2026-10-09' }}
      quick={[{ label, params: { [key]: val }, match: { [key]: val } }]} />);
    expect(screen.queryByRole('button', { name: 'All Sales' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(navigation.pushed.at(-1)?.startsWith(basePath)).toBe(true);
    expect(applied().get(key)).toBe(val);
    expect(applied().get('category')).toBe('1');
    expect(applied().get('sort')).toBe('amount');
    expect(applied().has('page')).toBe(false);
    expect(applied().has('statusSource')).toBe(false);
  });
  it('shows a date-only report toolbar without a redundant Filters button or search', () => {
    render(<FilterBar compact basePath="/reports/profit-and-loss" dateRange={{ preset: 'month', from: '2026-10-01', to: '2026-10-09' }} />);
    expect(screen.getByLabelText('Date range')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'last-month' } });
    expect(navigation.pushed.at(-1)).toBe('/reports/profit-and-loss?period=last-month');
  });
  it('counts and retains selected report filters when collapsed', () => {
    navigation.params = new URLSearchParams('supplier=1&category=1');
    render(<FilterBar compact basePath="/reports/purchases" active={[
      { key: 'supplier', label: 'Supplier', value: 'One' }, { key: 'category', label: 'Category', value: 'One' },
    ]} fields={['supplier', 'category'].map(key => ({ kind: 'select', key, label: key, allLabel: 'All', options: [{ value: '1', label: 'One' }] }))} />);
    const trigger = screen.getByRole('button', { name: 'Filters (2)' });
    fireEvent.click(trigger); fireEvent.click(trigger); fireEvent.click(trigger);
    expect((screen.getByLabelText('supplier') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('category') as HTMLSelectElement).value).toBe('1');
    expect(navigation.pushed).toHaveLength(0);
  });
});
