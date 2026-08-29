'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import {
  MONTH_NAMES,
  WEEKDAY_LABELS,
  clampToBounds,
  isSelectable,
  longDate,
  monthGrid,
  parseParts,
  shiftDate,
  shiftMonth,
  toDateString,
} from '@/lib/calendar';

/**
 * A date field, and the calendar behind it.
 *
 * Built rather than installed. The native `<input type="date">` this replaces
 * had two problems that mattered: it renders day-month or month-day depending
 * on the BROWSER's locale rather than on Ghana, so 03/04 was genuinely
 * ambiguous, and its calendar is browser chrome that no stylesheet can reach —
 * so it could not grey out the days inside a locked period, which is the one
 * thing the shop most needs a calendar to refuse.
 *
 * Three parts, in order of how often they are used:
 *
 *  - the segmented boxes, DD / MM / YYYY, labelled so the order is never in
 *    doubt. Typing fills them left to right; arrow keys step a part up or down.
 *  - the long date underneath, "Friday, 3 April 2026", which is the belt to
 *    that braces.
 *  - the calendar, for when somebody is looking for "the Tuesday before last"
 *    rather than a date they already know.
 *
 * The canonical value is always 'YYYY-MM-DD' in a hidden input, so the server
 * receives exactly what it received before and nothing downstream changed.
 */

export interface DateFieldProps {
  id?: string;
  name?: string;
  /** Uncontrolled starting value, 'YYYY-MM-DD'. */
  defaultValue?: string;
  /** Controlled value. Pass with `onChange`. */
  value?: string;
  onChange?: (value: string) => void;
  /** Nothing before this may be chosen. Usually the books-lock date. */
  min?: string | undefined;
  max?: string | undefined;
  /** Why a day is refused, shown when somebody tries one. */
  minReason?: string;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  /** Today, so the shortcut and the highlight agree with the shop's clock. */
  today?: string;
  /**
   * What this date IS, for the screen reader.
   *
   * Without it the three boxes announce "Day", "Month", "Year", which is fine
   * alone and useless on a page with several date fields: the purchases screen
   * has the delivery date plus one expiry per line, and somebody tabbing
   * through hears the same three words over and over. Given "Expires", they
   * announce "Expires day" and so on.
   */
  label?: string;
}

const SEG =
  'w-full bg-transparent text-center text-sm text-content outline-none tabular placeholder:text-content-subtle';

export function DateField({
  id,
  name,
  defaultValue = '',
  value: controlled,
  onChange,
  min,
  max,
  minReason,
  required,
  disabled,
  invalid,
  className,
  today,
  label,
}: DateFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;

  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = controlled ?? uncontrolled;

  function commit(next: string) {
    if (controlled === undefined) setUncontrolled(next);
    onChange?.(next);
  }

  // --- the three boxes -----------------------------------------------------
  const parts = parseParts(value);
  const [day, setDay] = useState(parts ? String(parts.day).padStart(2, '0') : '');
  const [month, setMonth] = useState(parts ? String(parts.month).padStart(2, '0') : '');
  const [year, setYear] = useState(parts ? String(parts.year) : '');

  /*
    Keep the boxes in step when the value changes from OUTSIDE: the calendar,
    the Today button, or a controlled parent resetting a filter.

    Adjusted during render against the previous value rather than in an effect.
    An effect would run after paint, so the boxes would show the old date for a
    frame after the calendar set a new one, and it is the pattern React itself
    warns against for exactly this job.
  */
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    const next = parseParts(value);
    if (next !== null) {
      setDay(String(next.day).padStart(2, '0'));
      setMonth(String(next.month).padStart(2, '0'));
      setYear(String(next.year));
    } else if (value === '') {
      setDay('');
      setMonth('');
      setYear('');
    }
  }

  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);

  /** Assemble a value from the boxes, but only once all three make a date. */
  function assemble(d: string, m: string, y: string) {
    if (d === '' || m === '' || y.length < 4) return;
    const candidate = toDateString(Number(y), Number(m), Number(d));
    if (parseParts(candidate) === null) return;
    commit(candidate);
  }

  function segmentKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    which: 'day' | 'month' | 'year',
  ) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // Stepping a part with the arrows only makes sense once there IS a date;
    // before that there is nothing to step from, so start at today.
    const base = parseParts(value) ? value : (today ?? '');
    if (base === '') return;
    const by = event.key === 'ArrowUp' ? 1 : -1;
    const moved =
      which === 'day'
        ? shiftDate(base, by)
        : which === 'month'
          ? monthShifted(base, by)
          : monthShifted(base, by * 12);
    const clamped = clampToBounds(moved, { min, max });
    if (clamped !== null) commit(clamped);
  }

  // --- the calendar --------------------------------------------------------
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState(false);

  const focusDate = parseParts(value) ? value : (today ?? toDateString(2026, 1, 1));
  const [cursor, setCursor] = useState(() => {
    const p = parseParts(focusDate)!;
    return { year: p.year, month: p.month };
  });

  /**
   * Where the calendar goes.
   *
   * Written straight onto the node rather than held in state. This is a
   * measurement — read the field's box, decide, write the position — and
   * putting it through a render would paint the popover in the wrong place
   * first and correct it after, which is a visible jump.
   */
  function place() {
    const field = fieldRef.current;
    const pop = popoverRef.current;
    if (!field || !pop) return;

    // Under 640px it is a sheet from the bottom edge, not a popover. Fingers
    // want bigger targets than a 280px panel, and a sheet cannot be pushed
    // off-screen by a field low down the page.
    if (window.matchMedia('(max-width: 639px)').matches) {
      pop.dataset['sheet'] = 'true';
      Object.assign(pop.style, {
        position: 'fixed',
        inset: 'auto 0 0 0',
        width: '100%',
        maxHeight: '85vh',
        overflowY: 'auto',
      });
      return;
    }

    delete pop.dataset['sheet'];
    const box = field.getBoundingClientRect();
    const height = pop.offsetHeight;
    const width = pop.offsetWidth;
    const roomBelow = window.innerHeight - box.bottom;

    // Above only when below genuinely will not fit AND there is more room up
    // there. Flipping toward the smaller gap would trade one clipped edge for
    // the other.
    const openUp = roomBelow < height + 8 && box.top > roomBelow;

    Object.assign(pop.style, {
      position: 'fixed',
      inset: 'auto',
      width: '',
      maxHeight: '',
      overflowY: '',
      top: `${openUp ? Math.max(8, box.top - height - 4) : box.bottom + 4}px`,
      // Clamped so a field near the right edge does not push it off-screen.
      left: `${Math.min(Math.max(8, box.left), window.innerWidth - width - 8)}px`,
    });
  }

  /**
   * Into the TOP LAYER, via the popover attribute.
   *
   * An absolutely-positioned panel is clipped by any scrolling ancestor, and
   * the filter drawer on a phone is exactly that: `max-h-[85vh]
   * overflow-y-auto`. The calendar was cut off inside it whichever way it
   * opened. The top layer is outside all of that, and settles every z-index
   * question at the same time.
   *
   * Guarded because the API is absent in the test DOM; there the panel simply
   * renders in place, which is all the tests need to drive it.
   */
  useLayoutEffect(() => {
    const pop = popoverRef.current;
    if (!open || !pop) return;
    if (typeof pop.showPopover === 'function' && !pop.matches(':popover-open')) {
      try {
        pop.showPopover();
      } catch {
        // Already shown, or the attribute is not honoured. Placement still works.
      }
    }
    place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (
        !popoverRef.current?.contains(event.target as Node) &&
        !triggerRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    /*
      Scrolling closes it rather than moving it. A calendar that hangs in place
      while the field slides away underneath reads as detached from the thing it
      belongs to, and following the field costs a listener firing on every
      frame of every scroll. Capture phase, so a scrolling PANEL counts and not
      just the window.
    */
    const onScroll = () => setOpen(false);
    const onResize = () => place();

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  /**
   * The day the keyboard is on, which is not the day that is chosen.
   *
   * A calendar grid takes ONE tab stop, not forty two. The focused day carries
   * `tabIndex=0` and every other day carries -1, so Tab moves past the whole
   * grid and the arrows move within it. That is the roving-focus pattern the
   * ARIA practices describe for exactly this control.
   */
  const [focusedDay, setFocusedDay] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);

  /**
   * Put the browser's focus where the roving focus says it is.
   *
   * A layout effect because it must happen before paint: moving focus after
   * the frame shows the outline jumping from the old day to the new one. This
   * writes to the DOM rather than to state, which is what an effect is for.
   */
  useLayoutEffect(() => {
    if (!open || focusedDay === null) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${focusedDay}"]`)
      ?.focus({ preventScroll: true });
  }, [open, focusedDay, cursor]);

  /** Move the keyboard, paging the month when the move leaves it. */
  function moveFocus(to: string) {
    setFocusedDay(to);
    const parts = parseParts(to);
    if (parts && (parts.year !== cursor.year || parts.month !== cursor.month)) {
      setCursor({ year: parts.year, month: parts.month });
    }
  }

  function gridKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const from = focusedDay ?? value ?? today;
    if (from === undefined || from === '' || parseParts(from) === null) return;

    const byDays: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };

    if (event.key in byDays) {
      event.preventDefault();
      moveFocus(shiftDate(from, byDays[event.key]!));
      return;
    }

    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      // Shift pages a year, which is the convention and saves twelve presses
      // when somebody is looking for a date last spring.
      const by = event.key === 'PageUp' ? -1 : 1;
      moveFocus(monthShifted(from, event.shiftKey ? by * 12 : by));
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      // The week, not the month: it is a grid, and Home means the start of the
      // row you are on.
      const column = weeks.flat().findIndex((cell) => cell.date === from) % 7;
      moveFocus(shiftDate(from, event.key === 'Home' ? -column : 6 - column));
    }
  }

  function choose(date: string) {
    if (!isSelectable(date, { min, max })) {
      // Say why rather than doing nothing. A button that silently ignores a
      // click reads as broken, and this one has a real reason to refuse.
      setRefused(true);
      return;
    }
    setRefused(false);
    commit(date);
    setOpen(false);
    triggerRef.current?.focus();
  }

  const showLong = parseParts(value) !== null;

  return (
    <div className={cn('relative', className)}>
      {/* What the server sees. Unchanged from the input this replaced. */}
      <input type="hidden" name={name} value={value} />

      <div
        ref={fieldRef}
        className={cn(
          'flex h-10 items-center rounded-lg border bg-surface-raised px-2',
          invalid ? 'border-danger' : 'border-line',
          disabled && 'cursor-not-allowed opacity-60',
          'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft',
        )}
      >
        <div className="flex flex-1 items-center gap-0.5">
          <Segment
            ref={dayRef}
            id={fieldId}
            aria-label={label ? `${label} day` : 'Day'}
            placeholder="DD"
            width="w-7"
            value={day}
            disabled={disabled}
            required={required}
            onKeyDown={(event) => segmentKeyDown(event, 'day')}
            onChange={(next) => {
              setDay(next);
              assemble(next, month, year);
              if (next.length === 2) monthRef.current?.focus();
            }}
          />
          <span aria-hidden className="text-content-subtle">
            /
          </span>
          <Segment
            ref={monthRef}
            aria-label={label ? `${label} month` : 'Month'}
            placeholder="MM"
            width="w-8"
            value={month}
            disabled={disabled}
            onKeyDown={(event) => segmentKeyDown(event, 'month')}
            onChange={(next) => {
              setMonth(next);
              assemble(day, next, year);
              if (next.length === 2) yearRef.current?.focus();
            }}
          />
          <span aria-hidden className="text-content-subtle">
            /
          </span>
          <Segment
            ref={yearRef}
            aria-label={label ? `${label} year` : 'Year'}
            placeholder="YYYY"
            width="w-12"
            maxLength={4}
            value={year}
            disabled={disabled}
            onKeyDown={(event) => segmentKeyDown(event, 'year')}
            onChange={(next) => {
              setYear(next);
              assemble(day, month, next);
            }}
          />
        </div>

        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => {
            // Land on the month the value is in, decided at the moment of
            // opening rather than watched for by an effect.
            if (!open) {
              const start = parseParts(value) ? value : (today ?? '');
              const p = parseParts(start);
              if (p) {
                setCursor({ year: p.year, month: p.month });
                // The keyboard starts on the chosen day, or on today when
                // nothing is chosen yet.
                setFocusedDay(start);
              }
              setRefused(false);
            }
            setOpen((current) => !current);
          }}
          aria-label="Open calendar"
          aria-expanded={open}
          className="ml-1 rounded p-1.5 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
            <path d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7ZM5 9h14v10H5V9Z" />
          </svg>
        </button>
      </div>

      {/*
        The line that makes 03/04 unambiguous. Rendered from the value, so it
        cannot describe a date other than the one that will be submitted.
      */}
      {showLong && <p className="mt-1 text-xs text-content-muted">{longDate(value)}</p>}

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Choose a date"
          popover="manual"
          className={cn(
            'z-50 w-[17.5rem] rounded-xl border border-line bg-surface-raised p-3 shadow-lg',
            // The popover top layer paints on its own; without this it inherits
            // the UA's centred, bordered box.
            'm-0 max-w-none overflow-visible',
            // As a sheet it spans the screen and squares off its bottom corners
            // against the edge it is sitting on.
            'data-[sheet]:w-full data-[sheet]:rounded-b-none data-[sheet]:border-x-0 data-[sheet]:border-b-0',
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-content">
              {MONTH_NAMES[cursor.month - 1]} {cursor.year}
            </p>
            <div className="flex gap-1">
              <Arrow
                label="Previous month"
                onClick={() => setCursor((c) => shiftMonth(c.year, c.month, -1))}
                d="M15 6 9 12l6 6"
              />
              <Arrow
                label="Next month"
                onClick={() => setCursor((c) => shiftMonth(c.year, c.month, 1))}
                d="M9 6l6 6-6 6"
              />
            </div>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label} className="py-1 text-center text-xs text-content-muted">
                {label}
              </span>
            ))}
          </div>

          <div
            ref={gridRef}
            role="grid"
            aria-label="Calendar"
            onKeyDown={gridKeyDown}
            className="grid grid-cols-7 gap-0.5"
          >
            {weeks.flat().map((cell) => {
              const selected = cell.date === value;
              const isToday = cell.date === today;
              const allowed = isSelectable(cell.date, { min, max });
              return (
                <button
                  key={cell.date}
                  type="button"
                  role="gridcell"
                  data-date={cell.date}
                  /*
                    `aria-disabled`, not `disabled`. A disabled button cannot
                    take focus, so the arrow keys would dead-end at the edge of
                    a locked period with no way past it. This stays focusable
                    and still refuses the click — and refusing out loud, with
                    the reason, beats a button that silently does nothing.
                  */
                  aria-disabled={!allowed}
                  aria-selected={selected}
                  aria-current={isToday ? 'date' : undefined}
                  aria-label={longDate(cell.date)}
                  tabIndex={cell.date === (focusedDay ?? value) ? 0 : -1}
                  onClick={() => choose(cell.date)}
                  className={cn(
                    'h-8 rounded-full text-sm transition-colors',
                    !cell.inMonth && 'text-content-subtle',
                    cell.inMonth && 'text-content',
                    allowed && !selected && 'hover:bg-surface-sunken',
                    selected && 'bg-accent font-semibold text-white',
                    isToday && !selected && 'ring-1 ring-accent',
                    // Not merely dimmed: struck through, so "you cannot pick
                    // this" is legible at a glance rather than a guess about
                    // contrast.
                    !allowed && 'cursor-not-allowed text-content-subtle line-through opacity-50',
                  )}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          {refused && (
            <p className="mt-2 border-t border-line pt-2 text-xs text-danger">
              {minReason ?? 'That date is outside the range this field allows.'}
            </p>
          )}

          <div className="mt-2 flex gap-2 border-t border-line pt-2">
            {today !== undefined && (
              <button
                type="button"
                onClick={() => choose(today)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
              >
                Today
              </button>
            )}
            {today !== undefined && (
              <button
                type="button"
                onClick={() => choose(shiftDate(today, -1))}
                className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent-soft"
              >
                Yesterday
              </button>
            )}
            {!required && (
              <button
                type="button"
                onClick={() => {
                  commit('');
                  setOpen(false);
                }}
                className="ml-auto rounded-lg px-2 py-1 text-xs font-medium text-content-muted hover:bg-surface-sunken"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Step whole months while keeping the day where it fits. */
function monthShifted(date: string, byMonths: number): string {
  const parts = parseParts(date);
  if (parts === null) return date;
  const { year, month } = shiftMonth(parts.year, parts.month, byMonths);
  // 31 January stepped a month is 28 February, not 3 March.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toDateString(year, month, Math.min(parts.day, lastDay));
}

function Arrow({ label, onClick, d }: { label: string; onClick: () => void; d: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="rounded p-1 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <path d={d} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function Segment({
  ref,
  id,
  value,
  width,
  maxLength = 2,
  onChange,
  ...rest
}: {
  ref: React.RefObject<HTMLInputElement | null>;
  id?: string;
  value: string;
  width: string;
  maxLength?: number;
  onChange: (value: string) => void;
  'aria-label': string;
  placeholder: string;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      {...rest}
      ref={ref}
      id={id}
      type="text"
      // Numeric keypad on a phone. `type="number"` would bring spinners and
      // accept "1e5", neither of which belongs in a date.
      inputMode="numeric"
      autoComplete="off"
      value={value}
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, maxLength))}
      className={cn(SEG, width)}
    />
  );
}
