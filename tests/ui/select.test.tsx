// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { renderToString } from 'react-dom/server';
import { Select } from '@/components/ui/select';

afterEach(cleanup);
const choices = <><option value="apple">Apple</option><option value="banana">Banana</option><option value="cherry">Cherry</option><option value="orange" disabled>Orange</option></>;
function open(element: HTMLElement) { fireEvent.keyDown(element, { key: 'ArrowDown' }); }

describe('themed dropdown', () => {
  it('keeps native form values, required validation and server-rendered fallback', () => {
    const html = renderToString(<Select name="fruit" defaultValue="cherry" required>{choices}</Select>);
    expect(html).toContain('<select'); expect(html).toContain('name="fruit"'); expect(html).toContain('selected=""');
    render(<form aria-label="Fruit form"><label htmlFor="fruit">Fruit</label><Select id="fruit" name="fruit" defaultValue="cherry" required>{choices}</Select></form>);
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('fruit')).toBe('cherry');
    open(screen.getByLabelText('Fruit'));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Banana' }));
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('fruit')).toBe('banana');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('dispatches one existing change handler and supports controlled selection', () => {
    const changed = vi.fn();
    function Controlled() {
      const [value, setValue] = useState('cherry');
      return <Select aria-label="Fruit" value={value} onChange={event => { changed(event.target.value); setValue(event.target.value); }}>{choices}</Select>;
    }
    render(<Controlled />); open(screen.getByRole('combobox'));
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: 'Cherry' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Apple' }));
    expect(changed).toHaveBeenCalledExactlyOnceWith('apple');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('apple');
  });
  it('supports keyboard movement, disabled options, Enter and Escape with focus restoration', () => {
    render(<Select aria-label="Fruit" defaultValue="cherry">{choices}</Select>);
    const control = screen.getByRole('combobox'); control.focus(); open(control);
    fireEvent.keyDown(control, { key: 'ArrowDown' }); // skips disabled Orange, wraps to Apple
    fireEvent.keyDown(control, { key: 'Enter' });
    expect((control as HTMLSelectElement).value).toBe('apple');
    expect(document.activeElement).toBe(control);
    open(control); fireEvent.keyDown(control, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull(); expect(document.activeElement).toBe(control);
  });
  it('searches product/customer/supplier lists locally and reports an empty result', () => {
    const changed = vi.fn();
    render(<Select id="filter-product" aria-label="Product" defaultValue="cherry" onChange={changed}>{choices}</Select>);
    open(screen.getByRole('combobox', { name: 'Product' }));
    const search = screen.getByRole('combobox', { name: 'Search options' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'BAN' } });
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('combobox', { name: 'Product' }) as HTMLSelectElement).value).toBe('banana');
    open(screen.getByRole('combobox', { name: 'Product' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search options' }), { target: { value: 'missing' } });
    expect(screen.getByRole('status').textContent).toBe('No matching options');
  });
  it('closes on outside interaction and leaves disabled options unchanged', () => {
    render(<><Select aria-label="Fruit" defaultValue="apple">{choices}</Select><button>Outside</button></>);
    const control = screen.getByRole('combobox'); open(control);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Orange' }));
    expect((control as HTMLSelectElement).value).toBe('apple');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('supports typeahead, Home, End and Tab without trapping keyboard focus', () => {
    render(<Select aria-label="Fruit" defaultValue="cherry">{choices}</Select>);
    const control = screen.getByRole('combobox'); open(control);
    fireEvent.keyDown(control, { key: 'b' }); fireEvent.keyDown(control, { key: 'Enter' });
    expect((control as HTMLSelectElement).value).toBe('banana');
    open(control); fireEvent.keyDown(control, { key: 'Home' }); fireEvent.keyDown(control, { key: 'Enter' });
    expect((control as HTMLSelectElement).value).toBe('apple');
    open(control); fireEvent.keyDown(control, { key: 'End' }); fireEvent.keyDown(control, { key: 'Enter' });
    expect((control as HTMLSelectElement).value).toBe('cherry');
    open(control); fireEvent.keyDown(control, { key: 'Tab' }); expect(screen.queryByRole('listbox')).toBeNull();
  });
});
