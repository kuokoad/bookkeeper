import { formatMoney, toDecimalString, type Minor } from '@/domain/money';
import { formatQty, type Qty } from '@/domain/quantity';

/**
 * Presentation helpers.
 *
 * These format values that have ALREADY been computed by the domain layer.
 * Nothing here calculates money — a total that first appears in a formatter is
 * a total nobody has tested.
 */

export interface CurrencyOptions {
  currencyCode?: string;
  /** Omit the currency code, e.g. inside a column already headed "GHS". */
  bare?: boolean;
}

export function money(value: Minor, options: CurrencyOptions = {}): string {
  return options.bare
    ? toDecimalString(value)
    : formatMoney(value, options.currencyCode ?? 'GHS');
}

/** Renders negatives in accounting parentheses: (1,250.00). */
export function moneyAccounting(value: Minor, options: CurrencyOptions = {}): string {
  if (value >= 0) return money(value, options);
  const positive = toDecimalString(Math.abs(value) as Minor);
  const prefix = options.bare ? '' : `${options.currencyCode ?? 'GHS'} `;
  return `${prefix}(${positive})`;
}

export function quantity(value: Qty, unit?: string): string {
  const formatted = formatQty(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

// --- dates -----------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shop-local business day as 'YYYY-MM-DD'. */
export function toBusinessDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parse 'YYYY-MM-DD' into a local Date at midnight. */
export function fromBusinessDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid business date: ${value}`);
  }
  return new Date(year, month - 1, day);
}

export function isValidBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = fromBusinessDate(value);
  return !Number.isNaN(parsed.getTime()) && toBusinessDate(parsed) === value;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export function formatDate(value: Date | string): string {
  const date = typeof value === 'string' ? fromBusinessDate(value) : value;
  return DATE_FORMAT.format(date);
}

export function formatDateTime(value: Date): string {
  return DATE_TIME_FORMAT.format(value);
}

export function formatTime(value: Date): string {
  return TIME_FORMAT.format(value);
}

/** "Today", "Yesterday", or a formatted date. */
export function formatRelativeDay(value: Date | string, now: Date = new Date()): string {
  const date = typeof value === 'string' ? fromBusinessDate(value) : value;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((today.getTime() - target.getTime()) / DAY_MS);

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff === -1) return 'Tomorrow';
  return formatDate(date);
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
