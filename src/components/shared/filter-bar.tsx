'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { Button } from '@/components/ui/button';
import { DateField } from '@/components/ui/date-field';
import { TextInput } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { DATE_PRESET_LABELS, type ActiveFilter, type DatePreset } from '@/lib/filters';

/**
 * One filter bar for the whole shop.
 *
 * Every list page describes the filters that make sense for ITS data and this
 * renders them the same way, so a shop owner learns the controls once. Nothing
 * here knows what a sale or an expense is — it moves values in and out of the
 * URL, and the page's server component turns the URL into a query.
 *
 * Three rules it enforces for every page at once:
 *
 *   - Changing any filter resets the page number. Landing on page 4 of a result
 *     set that now has one page is the classic filtering bug, and it is fixed
 *     here rather than in eleven places.
 *   - One-shot flash keys (`created=1`, `voided=1`) are dropped on every change,
 *     so a success banner cannot follow the owner around the filters.
 *   - Filters compose. Nothing clears another filter; each key is set or unset
 *     on top of what is already there.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export type FilterField =
  | {
      kind: 'search';
      key: string;
      label: string;
      placeholder?: string;
      /** Widen the box for a field people type sentences into. */
      wide?: boolean;
    }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: SelectOption[];
      /** Label for the empty option, e.g. "All categories". */
      allLabel: string;
    }
  | {
      kind: 'amount-range';
      minKey: string;
      maxKey: string;
      label: string;
      currency?: string;
    }
  /** A single date, for a report asked "as at" a day rather than over a range. */
  | { kind: 'date'; key: string; label: string; max?: string };

export interface QuickFilter {
  label: string;
  /** Params this quick filter sets. `null` clears a key. */
  params: Record<string, string | null>;
  /** Params that must ALL match for the chip to read as on. */
  match: Record<string, string | null>;
}

export interface DateRangeConfig {
  preset: DatePreset;
  from: string;
  to: string;
  /** Which presets to offer. Defaults to the full set bar `custom`. */
  presets?: DatePreset[];
  /** Query keys, so a page with two ranges can use its own names. */
  presetKey?: string;
  fromKey?: string;
  toKey?: string;
}

export interface FilterBarProps {
  basePath: string;
  fields?: FilterField[];
  quick?: QuickFilter[];
  dateRange?: DateRangeConfig;
  /** Chips for what is currently on, computed on the server. */
  active?: ActiveFilter[];
  /** Extra keys wiped on any change, on top of the built-in flash keys. */
  resetKeys?: string[];
  children?: ReactNode;
}

/**
 * The periods offered by default.
 *
 * `custom` is absent because it has its own pair of date boxes rather than a
 * button. Everything else a shop owner asks for is here, `last-week` included:
 * "how did last week go" is a question people ask on a Monday, and leaving it
 * out makes them work out two dates for the commonest comparison they make.
 */
const DEFAULT_PRESETS: DatePreset[] = [
  'today',
  'yesterday',
  'week',
  'last-week',
  'month',
  'last-month',
  'year',
  'all',
];

/** Keys that describe a one-off event, never a filter. Dropped on any change. */
const FLASH_KEYS = ['created', 'updated', 'voided', 'deleted', 'restored', 'error'];

/**
 * What can hold focus inside the drawer, in tab order.
 *
 * Read fresh on every keystroke rather than cached: the controls change as the
 * owner types — the Apply button appears, a chip goes — and a stale list would
 * trap focus against an element that is no longer there.
 *
 * `disabled` controls are excluded because the browser skips them anyway, and
 * the "Show results" button IS disabled while a filter is being applied, which
 * would otherwise leave the trap pinned to something unreachable.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

const CONTROL_CLASS =
  'h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content ' +
  'focus:outline-none focus-visible:outline-2 focus-visible:outline-accent';

export function FilterBar({
  basePath,
  fields = [],
  quick = [],
  dateRange,
  active = [],
  resetKeys = [],
  children,
}: FilterBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const presetKey = dateRange?.presetKey ?? 'period';
  const fromKey = dateRange?.fromKey ?? 'from';
  const toKey = dateRange?.toKey ?? 'to';

  /*
    Text and amount boxes are drafts until submitted. Selects and quick filters
    navigate the moment they change, which is what a pointer expects; typing
    must not, or every keystroke would be a round trip to the database.


    A draft belongs to the URL it was typed against, so the URL it was typed
    against is stored with it. Following a chip, the back button, or a link to
    a filtered view then shows THAT view's values rather than leaving somebody's
    half-typed search sitting over a different set of filters — and it happens
    during render, with no effect and no extra pass.
  */
  const signature = searchParams.toString();
  const [drafts, setDrafts] = useState<{ signature: string; values: Record<string, string> }>({
    signature,
    values: {},
  });
  const values = drafts.signature === signature ? drafts.values : {};

  function setDraft(key: string, value: string) {
    setDrafts({ signature, values: { ...values, [key]: value } });
  }

  function clearDrafts() {
    setDrafts({ signature, values: {} });
  }

  function valueOf(key: string): string {
    return values[key] ?? searchParams.get(key) ?? '';
  }

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') params.delete(key);
      else params.set(key, value);
    }

    // Any change to what is being asked puts the owner back at the first page.
    params.delete('page');
    for (const key of [...FLASH_KEYS, ...resetKeys]) params.delete(key);

    const query = params.toString();
    clearDrafts();
    setDrawerOpen(false);
    startTransition(() => router.push(query === '' ? basePath : `${basePath}?${query}`));
  }

  function submitDrafts(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const next: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) {
      next[key] = value.trim() === '' ? null : value.trim();
    }
    apply(next);
  }

  function clearAll() {
    clearDrafts();
    setDrawerOpen(false);
    startTransition(() => router.push(basePath));
  }

  function isQuickOn(filter: QuickFilter): boolean {
    return Object.entries(filter.match).every(([key, value]) =>
      value === null ? !searchParams.has(key) : searchParams.get(key) === value,
    );
  }

  function toggleQuick(filter: QuickFilter) {
    if (!isQuickOn(filter)) {
      apply(filter.params);
      return;
    }
    // Pressing an active quick filter again turns it off, rather than making it
    // a one-way door the owner has to find "Clear all" to escape.
    const off: Record<string, string | null> = {};
    for (const key of Object.keys(filter.params)) off[key] = null;
    apply(off);
  }

  const activeCount = active.length;
  const hasControls = fields.length > 0 || dateRange !== undefined;

  // --- the drawer is a modal, so it behaves like one ------------------------

  /**
   * Focus moves into the drawer when it opens and back where it came from when
   * it closes.
   *
   * Without this, opening the filters on a phone leaves focus behind on the
   * button underneath: a screen reader goes on announcing the page while a
   * sheet covers it, and the first Tab walks into the table rather than into
   * the controls that just appeared. Restoring focus on the way out matters
   * just as much — closing a drawer should put somebody back where they were,
   * not at the top of the document.
   *
   * The element to return to is read at open time rather than tracked, so it is
   * whatever actually had focus, however the drawer was opened.
   */
  useEffect(() => {
    if (!drawerOpen) return;

    const returnTo = document.activeElement as HTMLElement | null;
    focusableWithin(dialogRef.current)[0]?.focus();

    return () => {
      // Guard the call: the trigger can be gone by now if a filter change
      // re-rendered the bar, and focus then simply stays where the browser put it.
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [drawerOpen]);

  /**
   * Tab stays inside the drawer, and Escape gets out of it.
   *
   * A trap without an escape hatch is a keyboard prison, so the two belong in
   * the same place: whatever holds focus in, Escape lets out.
   */
  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setDrawerOpen(false);
      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = focusableWithin(dialogRef.current);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    // Only the two ends need handling; everything between them is the
    // browser's own tab order, which is the order to keep.
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // --- pieces --------------------------------------------------------------

  function renderDatePresets() {
    if (!dateRange) return null;
    const presets = dateRange.presets ?? DEFAULT_PRESETS;
    return (
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={dateRange.preset === preset ? 'primary' : 'secondary'}
            aria-pressed={dateRange.preset === preset}
            onClick={() => apply({ [presetKey]: preset, [fromKey]: null, [toKey]: null })}
          >
            {DATE_PRESET_LABELS[preset]}
          </Button>
        ))}
      </div>
    );
  }

  function renderCustomRange() {
    if (!dateRange) return null;

    /*
      The boxes show the range the SERVER resolved, not the raw query string.

      Those differ whenever the URL is junk — a hand-edited `?from=2026-13-45`
      is thrown away by the parser and the page falls back to this month. Echoing
      the raw value back left the box EMPTY while the table showed a month nobody
      had asked for, and nothing on the page said the dates had been ignored.
      Reading the resolved range means the controls always describe the data
      underneath them.

      `DateField` would render the junk no better — it parses the same way the
      server does and shows nothing for a date that is not one — so this is not
      something the new control made safe to skip.

      A draft still wins, because that is the owner mid-edit.
    */
    const resolved = dateRange.from.startsWith('0000') ? '' : dateRange.from;
    const fromValue = values[fromKey] ?? resolved;
    const toValue = values[toKey] ?? dateRange.to;
    return (
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`${fromKey}-input`} className="mb-1 block text-xs text-content-muted">
            From
          </label>
          <DateField
            id={`${fromKey}-input`}
            label="From"
            value={fromValue}
            max={toValue || undefined}
            onChange={(next) => setDraft(fromKey, next)}
            className="w-[11.5rem]"
          />
        </div>
        <div>
          <label htmlFor={`${toKey}-input`} className="mb-1 block text-xs text-content-muted">
            To
          </label>
          <DateField
            id={`${toKey}-input`}
            label="To"
            value={toValue}
            min={fromValue || undefined}
            onChange={(next) => setDraft(toKey, next)}
            className="w-[11.5rem]"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant={dateRange.preset === 'custom' ? 'primary' : 'secondary'}
          onClick={() =>
            apply({
              [presetKey]: 'custom',
              // An emptied box means "open at that end", which the parser
              // supports — so it is sent as a cleared key rather than being
              // quietly refilled with the value the owner just deleted.
              [fromKey]: fromValue === '' ? null : fromValue,
              [toKey]: toValue === '' ? null : toValue,
            })
          }
        >
          Apply dates
        </Button>
      </div>
    );
  }

  function renderFields(idPrefix: string) {
    return (
      <>
        {fields.map((field) => {
          if (field.kind === 'search') {
            const id = `${idPrefix}-${field.key}`;
            return (
              <div key={field.key}>
                <label htmlFor={id} className="mb-1 block text-xs text-content-muted">
                  {field.label}
                </label>
                <TextInput
                  id={id}
                  type="search"
                  autoComplete="off"
                  placeholder={field.placeholder ?? field.label}
                  value={valueOf(field.key)}
                  onChange={(event) =>
                    setDraft(field.key, event.target.value)
                  }
                  className={cn('h-10', field.wide ? 'w-full sm:w-72' : 'w-full sm:w-56')}
                />
              </div>
            );
          }

          if (field.kind === 'select') {
            const id = `${idPrefix}-${field.key}`;
            return (
              <div key={field.key}>
                <label htmlFor={id} className="mb-1 block text-xs text-content-muted">
                  {field.label}
                </label>
                <select
                  id={id}
                  value={searchParams.get(field.key) ?? ''}
                  onChange={(event) => apply({ [field.key]: event.target.value || null })}
                  className={cn(CONTROL_CLASS, 'w-full sm:w-auto')}
                >
                  <option value="">{field.allLabel}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          if (field.kind === 'date') {
            const id = `${idPrefix}-${field.key}`;
            return (
              <div key={field.key}>
                <label htmlFor={id} className="mb-1 block text-xs text-content-muted">
                  {field.label}
                </label>
                <DateField
                  id={id}
                  max={field.max}
                  value={valueOf(field.key)}
                  onChange={(next) => apply({ [field.key]: next || null })}
                  className="w-full sm:w-[11.5rem]"
                />
              </div>
            );
          }

          const minId = `${idPrefix}-${field.minKey}`;
          const maxId = `${idPrefix}-${field.maxKey}`;
          return (
            <div key={field.minKey}>
              <span className="mb-1 block text-xs text-content-muted">
                {field.label}
                {field.currency ? ` (${field.currency})` : ''}
              </span>
              <div className="flex items-center gap-1.5">
                <label htmlFor={minId} className="sr-only">
                  {field.label} from
                </label>
                <TextInput
                  id={minId}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Min"
                  value={valueOf(field.minKey)}
                  onChange={(event) =>
                    setDraft(field.minKey, event.target.value)
                  }
                  className="tabular h-10 w-24 text-right"
                />
                <span aria-hidden="true" className="text-content-subtle">
                  –
                </span>
                <label htmlFor={maxId} className="sr-only">
                  {field.label} to
                </label>
                <TextInput
                  id={maxId}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Max"
                  value={valueOf(field.maxKey)}
                  onChange={(event) =>
                    setDraft(field.maxKey, event.target.value)
                  }
                  className="tabular h-10 w-24 text-right"
                />
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // --- render --------------------------------------------------------------

  return (
    <section aria-label="Filters" className="mb-4 space-y-3 no-print">
      {quick.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {quick.map((filter) => {
            const on = isQuickOn(filter);
            return (
              <Button
                key={filter.label}
                type="button"
                size="sm"
                variant={on ? 'primary' : 'secondary'}
                aria-pressed={on}
                onClick={() => toggleQuick(filter)}
              >
                {filter.label}
              </Button>
            );
          })}
        </div>
      )}

      {/* Phone: one button that opens the controls, so a filter bar never eats
          the screen above a table people came to read. */}
      {hasControls && (
        <div className="flex items-center gap-2 md:hidden">
          <Button
            type="button"
            size="sm"
            variant={activeCount > 0 ? 'primary' : 'secondary'}
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
          >
            Filters{activeCount > 0 ? ` (${activeCount})` : ''}
          </Button>
          {pending && <span className="text-xs text-content-subtle">Loading…</span>}
        </div>
      )}

      {/* Desktop: everything inline above the table. */}
      {hasControls && (
        <form onSubmit={submitDrafts} className="hidden md:block">
          <div className="flex flex-wrap items-end gap-3">
            {renderFields('filter')}
            {/* Only the typed fields need submitting; selects and dates go on change. */}
            {fields.some(
              (field) => field.kind === 'search' || field.kind === 'amount-range',
            ) && (
              <Button type="submit" size="sm" variant="secondary" disabled={pending}>
                {pending ? 'Applying…' : 'Apply'}
              </Button>
            )}
            {children}
          </div>
          {dateRange && (
            <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
              {renderDatePresets()}
              {renderCustomRange()}
            </div>
          )}
        </form>
      )}

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-content-subtle">Showing:</span>
          {active.map((chip) => (
            <button
              key={`${chip.key}-${chip.value}`}
              type="button"
              onClick={() => {
                const off: Record<string, string | null> = { [chip.key]: null };
                for (const key of chip.alsoClears ?? []) off[key] = null;
                apply(off);
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border border-line-strong',
                'bg-surface-sunken px-2.5 py-1 text-xs text-content',
                'hover:bg-surface-raised focus:outline-none focus-visible:outline-2 focus-visible:outline-accent',
              )}
            >
              <span className="text-content-muted">{chip.label}:</span>
              <span className="font-medium">{chip.value}</span>
              <span aria-hidden="true" className="text-content-subtle">
                ✕
              </span>
              <span className="sr-only">Remove this filter</span>
            </button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      )}

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden">
          {/*
            The scrim closes the drawer on a tap but is deliberately NOT a
            button. It sits outside the dialog, so as a focusable element it
            would be a tab stop the trap below cannot reach — the one place
            keyboard focus could leak out of a modal. Keyboard and screen-reader
            users close with Escape or the Close button, both of which are
            inside the dialog.
          */}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
            onKeyDown={onDialogKeyDown}
            className="relative max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface-raised p-4 pb-6"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-content">Filters</h2>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setDrawerOpen(false)}
              >
                Close
              </Button>
            </div>

            <form onSubmit={submitDrafts} className="space-y-4">
              {renderFields('drawer')}
              {dateRange && (
                <div className="space-y-3">
                  <span className="block text-xs text-content-muted">Period</span>
                  {renderDatePresets()}
                  {renderCustomRange()}
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <Button type="submit" fullWidth disabled={pending}>
                  {pending ? 'Loading…' : 'Show results'}
                </Button>
                <Button type="button" variant="secondary" onClick={clearAll}>
                  Clear all
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
