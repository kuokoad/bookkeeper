'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';
import { DATE_PRESETS, DATE_PRESET_LABELS, parseAmount, type DatePreset } from '@/lib/filters';
import type { FilterBarProps } from './filter-bar';

const CONTROL = 'h-10 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content focus-visible:outline-2 focus-visible:outline-accent';
const FLASH_KEYS = ['created', 'updated', 'voided', 'deleted', 'restored', 'error'];

/** Compact presentation: each page's URL parser and services remain authoritative. */
export function CompactFilters({ basePath, compactSales = false, fields = [], quick = [], dateRange, active = [], resetKeys = [], children }: FilterBarProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const signature = params.toString();
  const [draft, setDraft] = useState<{ signature: string; values: Record<string, string> }>({ signature, values: {} });
  const values = draft.signature === signature ? draft.values : {};
  const value = (key: string) => values[key] ?? params.get(key) ?? '';
  const setValue = (key: string, next: string) => setDraft({ signature, values: { ...values, [key]: next } });
  const advanced = fields.filter(field => field.kind !== 'search');
  const search = fields.find(field => field.kind === 'search');
  const advancedKeys = advanced.flatMap(field => field.kind === 'amount-range' ? [field.minKey, field.maxKey] : [field.key]);
  const activeKeys = new Set(active.flatMap(chip => [chip.key, ...(chip.alsoClears ?? [])]));
  const count = advancedKeys.filter(key => key === 'min' || key === 'max'
    ? parseAmount(params.get(key) ?? undefined) !== undefined
    : activeKeys.has(key) && !(compactSales && key === 'status' && params.get('status') === 'VOIDED' && params.get('statusSource') === 'quick')).length;
  const presetKey = dateRange?.presetKey ?? 'period';
  const fromKey = dateRange?.fromKey ?? 'from';
  const toKey = dateRange?.toKey ?? 'to';
  const [customSignature, setCustomSignature] = useState<string | null>(null);
  const custom = customSignature === signature || dateRange?.preset === 'custom';

  function apply(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, val] of Object.entries(changes)) {
      if (val === null || val.trim() === '') next.delete(key);
      else next.set(key, val.trim());
    }
    next.delete('page');
    for (const key of [...FLASH_KEYS, ...resetKeys]) next.delete(key);
    setDraft({ signature, values: {} });
    setCustomSignature(null);
    startTransition(() => router.push(next.size ? `${basePath}?${next}` : basePath));
  }
  function submitAdvanced(event: FormEvent) {
    event.preventDefault();
    const changes: Record<string, string | null> = {};
    for (const key of advancedKeys) if (key in values) changes[key] = value(key);
    if (compactSales && 'status' in changes) changes.statusSource = null;
    apply(changes);
  }
  function clear() {
    setDraft({ signature, values: {} });
    setCustomSignature(null);
    startTransition(() => router.push(basePath));
  }
  const quickVoided = params.get('statusSource') === 'quick' && params.get('status') === 'VOIDED';
  const allSales = !params.has('paid') && !params.has('method') && !quickVoided;

  return (
    <section aria-label={compactSales ? 'Sales filters' : 'Filters'} aria-busy={pending} className="no-print mb-4 space-y-3">
      <div className={search ? 'grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]' : 'flex flex-wrap items-end gap-2'}>
        {search && search.kind === 'search' && (
          <form className="col-span-2 flex min-w-0 items-end gap-2 sm:col-span-1" onSubmit={event => { event.preventDefault(); apply({ [search.key]: value(search.key) }); }}>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${panelId}-search`} className="mb-1 block text-xs text-content-muted">Search</label>
              <TextInput id={`${panelId}-search`} type="search" autoComplete="off" placeholder={search.placeholder}
                value={value(search.key)} onChange={event => setValue(search.key, event.target.value)} className="h-10 w-full" />
            </div>
            <Button type="submit" variant="secondary" disabled={pending}>Search</Button>
          </form>
        )}
        {dateRange && <div>
          <label htmlFor={`${panelId}-period`} className="mb-1 block text-xs text-content-muted">Date range</label>
          <select id={`${panelId}-period`} className={CONTROL} value={custom ? 'custom' : dateRange.preset} onChange={event => {
            const preset = event.target.value as DatePreset;
            if (preset === 'custom') setCustomSignature(signature);
            else apply({ [presetKey]: preset, [fromKey]: null, [toKey]: null });
          }}>
            {DATE_PRESETS.map(preset => <option key={preset} value={preset}>{DATE_PRESET_LABELS[preset]}</option>)}
          </select>
        </div>}
        {advanced.length > 0 && <Button type="button" variant="secondary" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          Filters{count > 0 ? ` (${count})` : ''}
        </Button>}
        {children}
      </div>
      {custom && dateRange && <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault(); apply({ [presetKey]: 'custom', [fromKey]: values[fromKey] ?? (dateRange.from.startsWith('0000') ? '' : dateRange.from), [toKey]: values[toKey] ?? dateRange.to });
      }}>
        {[{ key: fromKey, label: 'From', resolved: dateRange.from.startsWith('0000') ? '' : dateRange.from }, { key: toKey, label: 'To', resolved: dateRange.to }].map(field => <div key={field.key}>
          <label className="mb-1 block text-xs text-content-muted" htmlFor={`${panelId}-${field.key}`}>{field.label}</label>
          <DateField id={`${panelId}-${field.key}`} label={field.label} value={values[field.key] ?? field.resolved} onChange={next => setValue(field.key, next)} />
        </div>)}
        <Button type="submit" variant="secondary" disabled={pending}>Apply dates</Button>
      </form>}
      {(compactSales || quick.length > 0) && <div className="flex flex-wrap gap-1.5" aria-label={compactSales ? 'Sales types' : 'Quick filters'}>
        {compactSales && <Button type="button" size="sm" variant={allSales ? 'primary' : 'secondary'} aria-pressed={allSales}
          title="Clear quick filters; keep advanced filters and dates" onClick={() => apply({ paid: null, method: null, ...(quickVoided ? { status: null, statusSource: null } : {}) })}>All Sales</Button>
        }
        {quick.map(filter => {
          const on = Object.entries(filter.match).every(([key, val]) =>
            key === presetKey && dateRange ? dateRange.preset === val : params.get(key) === val);
          return <Button key={filter.label} type="button" size="sm" aria-pressed={on} variant={on ? 'primary' : 'secondary'} onClick={() => {
            const changes = on ? Object.fromEntries(Object.keys(filter.params).map(key => [key, null])) : { ...filter.params };
            if (compactSales && 'status' in filter.params) changes.statusSource = on ? null : 'quick';
            apply(changes);
          }}>{filter.label}</Button>;
        })}
      </div>}
      <div id={panelId} hidden={!open} className="rounded-lg border border-line bg-surface-raised p-3">
        <form onSubmit={submitAdvanced}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {advanced.flatMap(field => {
              if (field.kind === 'select') return [<div key={field.key}>
                <label htmlFor={`${panelId}-${field.key}`} className="mb-1 block text-xs text-content-muted">{field.label}</label>
                <select id={`${panelId}-${field.key}`} className={CONTROL} value={value(field.key)} onChange={event => setValue(field.key, event.target.value)}>
                  <option value="">{field.allLabel}</option>
                  {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>];
              if (field.kind === 'amount-range') return [{ key: field.minKey, label: `Minimum ${field.label.toLowerCase()}` }, { key: field.maxKey, label: `Maximum ${field.label.toLowerCase()}` }].map(item => <div key={item.key}>
                <label htmlFor={`${panelId}-${item.key}`} className="mb-1 block text-xs text-content-muted">{item.label}{field.currency ? ` (${field.currency})` : ''}</label>
                <TextInput id={`${panelId}-${item.key}`} className="h-10 w-full tabular" inputMode="decimal" value={value(item.key)} onChange={event => setValue(item.key, event.target.value)} />
              </div>);
              if (field.kind === 'date') return [<div key={field.key}>
                <label htmlFor={`${panelId}-${field.key}`} className="mb-1 block text-xs text-content-muted">{field.label}</label>
                <DateField id={`${panelId}-${field.key}`} label={field.label} value={value(field.key)} max={field.max} onChange={next => setValue(field.key, next)} />
              </div>];
              return [];
            })}
          </div>
          <div className="mt-3 flex gap-2"><Button type="submit" disabled={pending}>Apply Filters</Button><Button type="button" variant="ghost" onClick={clear}>Clear Filters</Button></div>
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {active.map(chip => <Button key={chip.key} type="button" variant="secondary" size="sm" onClick={() => {
          const changes: Record<string, string | null> = { [chip.key]: null };
          for (const key of chip.alsoClears ?? []) changes[key] = null;
          if (compactSales && chip.key === 'status') changes.statusSource = null;
          apply(changes);
        }} aria-label={`Remove ${chip.label}: ${chip.value}`}>{chip.label}: {chip.value} <span aria-hidden="true">×</span></Button>)}
        {active.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={clear}>Clear Filters</Button>}
        {pending && <span role="status" className="text-xs text-content-muted">Updating results…</span>}
      </div>
    </section>
  );
}
