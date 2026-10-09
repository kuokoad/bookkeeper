'use client';

import { useEffect, useId, useRef, useState, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

type Option = { value: string; label: string; disabled: boolean };
type Props = SelectHTMLAttributes<HTMLSelectElement> & { searchable?: boolean };

/** Native form semantics and no-JS fallback, enhanced with a themed option menu. */
export function Select({ searchable, className, children, onChange, onKeyDown, ...props }: Props) {
  const control = useRef<HTMLSelectElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Option[]>([]);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState('');
  const [menuLabel, setMenuLabel] = useState('Options');
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 280 });
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const typeahead = useRef('');
  const lastTyped = useRef(0);
  const canSearch = searchable ?? /product|customer|supplier/i.test(`${props.id ?? ''} ${props.name ?? ''} ${props['aria-label'] ?? ''}`);
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  function close(restore = false) {
    setOpen(false);
    if (restore) control.current?.focus();
  }
  function show() {
    const element = control.current;
    if (!element || element.disabled) return;
    const next = Array.from(element.options).map(option => ({ value: option.value, label: option.text, disabled: option.disabled || option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled }));
    const rect = element.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const height = Math.min(320, Math.max(below, above), next.length * 40 + (canSearch ? 60 : 16));
    const down = below >= Math.min(height, 200) || below >= above;
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 24);
    setPosition({ top: down ? rect.bottom + 6 : Math.max(8, rect.top - height - 6), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, maxHeight: Math.max(100, height) });
    setOptions(next); setSelected(element.value); setQuery('');
    setMenuLabel(props['aria-label'] ?? element.labels?.[0]?.textContent?.trim() ?? 'Options');
    setActive(Math.max(0, next.findIndex(option => option.value === element.value && !option.disabled)));
    setTarget(element.closest<HTMLElement>('[role="dialog"]') ?? element.closest<HTMLElement>('.app-shell') ?? document.body);
    setOpen(true);
  }
  function choose(option: Option) {
    const element = control.current;
    if (!element || option.disabled) return;
    element.value = option.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    close(true);
  }
  function move(direction: number) {
    if (!filtered.length) return;
    let next = active;
    for (let i = 0; i < filtered.length; i++) {
      next = (next + direction + filtered.length) % filtered.length;
      if (!filtered[next]?.disabled) { setActive(next); break; }
    }
  }
  function keyboard(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Enter' || event.key === ' ' && event.target !== search.current) { event.preventDefault(); if (filtered[active]) choose(filtered[active]); }
    else if (event.key === 'Home' && event.target !== search.current) { event.preventDefault(); setActive(filtered.findIndex(option => !option.disabled)); }
    else if (event.key === 'End' && event.target !== search.current) { event.preventDefault(); setActive(filtered.findLastIndex(option => !option.disabled)); }
    else if (!canSearch && event.key.length === 1) {
      event.preventDefault();
      typeahead.current = Date.now() - lastTyped.current > 700 ? event.key : typeahead.current + event.key;
      lastTyped.current = Date.now();
      const found = filtered.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead.current.toLocaleLowerCase()));
      if (found >= 0) setActive(found);
    }
  }
  useEffect(() => {
    if (!open) return;
    if (canSearch) search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && event.target !== control.current) close();
    };
    const reposition = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [open, canSearch]);
  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  return <span className={cn('relative inline-block min-w-0 align-middle', className?.includes('w-full') ? 'w-full' : '')}>
    <select {...props} ref={control} className={cn('appearance-none rounded-lg border border-line-strong bg-surface-raised py-2 pl-3 pr-9 text-left text-content focus:outline-none focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60', className, 'pr-9')}
      aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && !canSearch ? `${listId}-${active}` : undefined}
      onPointerDown={event => { if (event.button === 0) { event.preventDefault(); control.current?.focus(); if (open) close(); else show(); } }}
      onMouseDown={event => event.preventDefault()}
      onClick={event => { event.preventDefault(); if (event.detail === 0 && !open) show(); }}
      onChange={event => { setSelected(event.target.value); onChange?.(event); }}
      onKeyDown={event => {
        onKeyDown?.(event); if (event.defaultPrevented) return;
        if (open) keyboard(event);
        else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(); }
      }}>
      {children}
    </select>
    <svg aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="m6 9 6 6 6-6" /></svg>
    {open && target && createPortal(<div ref={menu} className="fixed z-[100] flex flex-col rounded-xl border border-line bg-surface-raised p-2 shadow-lg" style={position} onKeyDown={keyboard}>
      {canSearch && <input ref={search} type="search" aria-label="Search options" placeholder="Search…" className="mb-2 h-10 w-full shrink-0 rounded-lg border border-line-strong bg-surface px-3 text-sm text-content placeholder:text-content-subtle" value={query}
        role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
        onChange={event => { setQuery(event.target.value); setActive(0); }} />}
      <div id={listId} role="listbox" aria-label={menuLabel} className="min-h-0 overflow-y-auto">
        {filtered.map((option, index) => <div key={`${option.value}-${index}`} id={`${listId}-${index}`} role="option" aria-selected={option.value === selected} aria-disabled={option.disabled || undefined} data-option-index={index}
          className={cn('flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-content', index === active || option.value === selected ? 'bg-surface-sunken' : 'hover:bg-surface-sunken', option.disabled && 'cursor-not-allowed opacity-50')}
          onMouseDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }} onClick={() => choose(option)}>
          <span>{option.label}</span>
          {option.value === selected && <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 4 4L19 6" /></svg>}
        </div>)}
        {filtered.length === 0 && <p role="status" className="px-3 py-3 text-sm text-content-muted">No matching options</p>}
      </div>
    </div>, target)}
  </span>;
}
