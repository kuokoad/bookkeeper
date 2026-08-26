import { minor, parseMoney, type Minor } from '@/domain/money';
import { isValidBusinessDate, toBusinessDate } from '@/lib/format';

/**
 * Filter parsing, in one place.
 *
 * Every list and report in the shop reads its filters from the URL, so the URL
 * is the single source of truth: a filtered view can be refreshed, bookmarked,
 * shared with the accountant, and stepped back out of with the browser's own
 * back button. Nothing here touches the database — these functions turn a query
 * string into VALIDATED values, and the services turn those into SQL.
 *
 * The rule for every parser below is the same: junk becomes `undefined`, never
 * an exception and never a raw string passed onwards. A hand-edited query
 * string is not an error worth a 500 page; it is a filter the shop did not
 * mean, and dropping it shows them everything rather than nothing.
 */

// --- dates -----------------------------------------------------------------

export interface DateRange {
  from: string;
  to: string;
}

/**
 * The date questions a shop owner actually asks.
 *
 * `all` is not "no filter" — it is a real range ending today, so a period
 * always has two ends and every caller can assume `from <= to`.
 */
export const DATE_PRESETS = [
  'today',
  'yesterday',
  'week',
  'last-week',
  'month',
  'last-month',
  'year',
  'all',
  'custom',
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  'last-week': 'Last week',
  month: 'This month',
  'last-month': 'Last month',
  year: 'This year',
  all: 'Everything',
  custom: 'Custom range',
};

/** The earliest date the shop can hold. Cheaper than a NULL branch everywhere. */
export const EARLIEST_DATE = '0000-01-01';

function iso(date: Date): string {
  return toBusinessDate(date);
}

function shiftDays(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00`);
  date.setDate(date.getDate() + days);
  return iso(date);
}

/**
 * Turn a preset into a real range of business days.
 *
 * Both ends are INCLUSIVE, and that is not a detail. Business dates are stored
 * as 'YYYY-MM-DD' text and compared with `>=` and `<=` against the same, so a
 * range of 1 to 15 August covers every sale dated the 15th whatever time of day
 * it was rung up. Filtering on the timestamp instead would silently drop the
 * evening's takings on the last day of every range the shop ever looks at.
 *
 * The week starts on Monday, which is how a Ghanaian shop week runs.
 */
export function resolveDateRange(
  preset: string | undefined,
  from: string | undefined,
  to: string | undefined,
  today: string = toBusinessDate(),
): { range: DateRange; preset: DatePreset } {
  const now = new Date(`${today}T00:00:00`);

  const mondayOf = (date: Date): Date => {
    const day = date.getDay(); // 0 = Sunday
    const monday = new Date(date);
    monday.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
    return monday;
  };

  switch (preset) {
    case 'today':
      return { range: { from: today, to: today }, preset: 'today' };

    case 'yesterday': {
      const yesterday = shiftDays(today, -1);
      return { range: { from: yesterday, to: yesterday }, preset: 'yesterday' };
    }

    case 'week':
      return { range: { from: iso(mondayOf(now)), to: today }, preset: 'week' };

    case 'last-week': {
      const thisMonday = mondayOf(now);
      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(thisMonday.getDate() - 7);
      const lastSunday = new Date(thisMonday);
      lastSunday.setDate(thisMonday.getDate() - 1);
      return { range: { from: iso(lastMonday), to: iso(lastSunday) }, preset: 'last-week' };
    }

    case 'last-month': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { range: { from: iso(first), to: iso(last) }, preset: 'last-month' };
    }

    case 'year':
      return { range: { from: `${today.slice(0, 4)}-01-01`, to: today }, preset: 'year' };

    case 'all':
      return { range: { from: EARLIEST_DATE, to: today }, preset: 'all' };

    case 'custom': {
      // A half-filled custom range is still a question worth answering: one end
      // given means "from then onwards" or "up to then", not "ignore my dates".
      const start = from && isValidBusinessDate(from) ? from : undefined;
      const end = to && isValidBusinessDate(to) ? to : undefined;
      if (start !== undefined || end !== undefined) {
        // Ends entered the wrong way round are a slip, not a request for
        // nothing. Swapping shows what they meant.
        const [low, high] =
          start !== undefined && end !== undefined && start > end
            ? [end, start]
            : [start ?? EARLIEST_DATE, end ?? today];
        return { range: { from: low, to: high }, preset: 'custom' };
      }
      break;
    }

    default:
      break;
  }

  // Anything unrecognised falls back to this month, the most common question.
  return { range: { from: `${today.slice(0, 7)}-01`, to: today }, preset: 'month' };
}

/** Human description of a range, for a report header. */
export function describeDateRange(range: DateRange, preset: DatePreset, today: string): string {
  if (preset === 'all') return `Everything up to ${range.to}`;
  if (range.from === range.to) return range.from;
  if (range.from === EARLIEST_DATE) return `Up to ${range.to}`;
  if (range.to === today && preset !== 'custom') return `${range.from} to today`;
  return `${range.from} to ${range.to}`;
}

// --- scalars ---------------------------------------------------------------

/** A positive integer id, or undefined. Rejects 0, negatives and junk. */
export function parseId(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** One of a fixed set, or undefined. The only way an enum filter reaches SQL. */
export function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** A business date, or undefined. */
export function parseDate(value: string | undefined): string | undefined {
  return value !== undefined && isValidBusinessDate(value) ? value : undefined;
}

/** A search term, trimmed and capped. Empty and whitespace become undefined. */
export function parseSearch(value: string | undefined, maxLength = 100): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A money amount typed into a filter box, in minor units.
 *
 * Lenient by design: `parseMoney` throws for the till, where a wrong figure
 * must never be guessed, but a filter box is a question and a typo in it should
 * narrow nothing rather than break the page.
 */
export function parseAmount(value: string | undefined): Minor | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    return parseMoney(value);
  } catch {
    return undefined;
  }
}

/**
 * An amount range, both ends optional and put back in order if reversed.
 */
export function parseAmountRange(
  min: string | undefined,
  max: string | undefined,
): { minAmount?: Minor; maxAmount?: Minor } {
  const low = parseAmount(min);
  const high = parseAmount(max);
  if (low !== undefined && high !== undefined && low > high) {
    return { minAmount: high, maxAmount: low };
  }
  return {
    ...(low !== undefined ? { minAmount: low } : {}),
    ...(high !== undefined ? { maxAmount: high } : {}),
  };
}

// --- pagination ------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PageQuery {
  page: number;
  pageSize: number;
  offset: number;
}

export function parsePage(
  value: string | undefined,
  pageSize: number = DEFAULT_PAGE_SIZE,
): PageQuery {
  const parsed = value === undefined ? 1 : Number(value);
  const page = Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
  const size = Math.min(Math.max(1, Math.trunc(pageSize)), MAX_PAGE_SIZE);
  return { page, pageSize: size, offset: (page - 1) * size };
}

/**
 * The page a result set can actually show.
 *
 * Filtering down to 27 rows while the URL still says page 4 would show an empty
 * table over a pager insisting there are results. Clamping means the last page
 * is shown instead, which is what the owner meant by "the end of the list".
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(page, lastPage);
}

// --- query strings ---------------------------------------------------------

export type FilterValues = Record<string, string | number | undefined>;

/**
 * Build a query string from filter values, dropping the empty ones.
 *
 * Used for every link that must CARRY the current filters — pagination, sort
 * headers, and the CSV download, which is the one that matters most: an export
 * that ignores the filters hands the accountant a different set of numbers from
 * the one on screen.
 */
export function buildQuery(values: FilterValues): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** `buildQuery` with one key changed, for a pager or a sort header. */
export function withParam(
  values: FilterValues,
  key: string,
  value: string | number | undefined,
): string {
  return buildQuery({ ...values, [key]: value });
}

/**
 * The filter keys a cashbook page carries, for the trip back from a form.
 *
 * Recording or voiding an expense posts to a server action and lands back on
 * the list. Without these the owner is returned to an unfiltered page, and the
 * filter they were working in has to be rebuilt by hand every time they touch a
 * row — which is exactly when they are least likely to want to.
 */
export const CASHBOOK_FILTER_KEYS = [
  'period',
  'from',
  'to',
  'q',
  'category',
  'account',
  'staff',
  'status',
  'min',
  'max',
  'sort',
  'direction',
  'page',
] as const;

/**
 * Rebuild a query string from a form field, keeping only keys we know.
 *
 * This takes a QUERY STRING and never a path, and returns a query string, so a
 * redirect built from it cannot be pointed anywhere but the page that sent it.
 * Anything unrecognised is dropped rather than escaped: a redirect target is
 * not the place to be clever about untrusted input.
 */
export function sanitiseFilterQuery(
  raw: unknown,
  allowed: readonly string[] = CASHBOOK_FILTER_KEYS,
): string {
  if (typeof raw !== 'string' || raw === '') return '';

  const source = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
  const kept = new URLSearchParams();

  for (const key of allowed) {
    const value = source.get(key);
    // The same cap the search parser uses, so a long value cannot be smuggled
    // back in through the return trip.
    if (value !== null && value !== '' && value.length <= 100) kept.set(key, value);
  }

  return kept.toString();
}

// --- sorting ---------------------------------------------------------------

export type SortDirection = 'asc' | 'desc';

export interface SortQuery<T extends string> {
  sort: T;
  direction: SortDirection;
}

/**
 * A sort column and direction, both validated against a whitelist.
 *
 * The whitelist is the point: a sort key reaches an ORDER BY, so it can never
 * be a string that came off the wire.
 */
export function parseSort<T extends string>(
  sort: string | undefined,
  direction: string | undefined,
  allowed: readonly T[],
  fallback: T,
  fallbackDirection: SortDirection = 'desc',
): SortQuery<T> {
  return {
    sort: parseEnum(sort, allowed) ?? fallback,
    direction: parseEnum(direction, ['asc', 'desc'] as const) ?? fallbackDirection,
  };
}

// --- active filter reporting ----------------------------------------------

export interface ActiveFilter {
  /** The query key to clear when the chip is dismissed. */
  key: string;
  /** What the filter is, e.g. "Customer". */
  label: string;
  /** What it is set to, e.g. "Kofi Mensah". */
  value: string;
  /** Extra keys cleared alongside, e.g. a custom range clears from AND to. */
  alsoClears?: string[];
}

/**
 * How many filters are on, for the `Filters (3)` button on a phone.
 *
 * The date range is deliberately excluded from the count on pages where a
 * period is always set: "this month" is the resting state, not a filter the
 * owner switched on, and counting it would leave the button reading `Filters
 * (1)` on a page nobody has touched.
 */
export function countActiveFilters(filters: readonly ActiveFilter[]): number {
  return filters.length;
}

/** Money for a filter chip, without the currency code. */
export function chipAmount(value: Minor): string {
  return (value / 100).toFixed(2);
}

/** The zero of Minor, for callers that want a floor without importing money. */
export const ZERO_MINOR = minor(0);
