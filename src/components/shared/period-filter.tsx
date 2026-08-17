import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';

export interface Period {
  from: string;
  to: string;
}

/** Named periods a shop owner actually asks for. */
export type PeriodPreset =
  | 'today'
  | 'week'
  | 'month'
  | 'last-month'
  | 'year'
  | 'all'
  | 'custom';

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Turn a preset into a real date range.
 *
 * The week starts on Monday, which is how a Ghanaian shop week runs, and every
 * range is inclusive at both ends.
 */
export function resolvePeriod(
  preset: string | undefined,
  from: string | undefined,
  to: string | undefined,
  today: string,
): { period: Period; preset: PeriodPreset } {
  const now = new Date(`${today}T00:00:00`);

  switch (preset) {
    case 'today':
      return { period: { from: today, to: today }, preset: 'today' };

    case 'week': {
      const day = now.getDay(); // 0 = Sunday
      const monday = new Date(now);
      monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      return { period: { from: iso(monday), to: today }, preset: 'week' };
    }

    case 'last-month': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { period: { from: iso(first), to: iso(last) }, preset: 'last-month' };
    }

    case 'year':
      return { period: { from: `${today.slice(0, 4)}-01-01`, to: today }, preset: 'year' };

    case 'all':
      return { period: { from: '0000-01-01', to: today }, preset: 'all' };

    case 'custom':
      if (from && to) return { period: { from, to }, preset: 'custom' };
      break;

    default:
      break;
  }

  // Anything unrecognised falls back to this month, the most common question.
  return { period: { from: `${today.slice(0, 7)}-01`, to: today }, preset: 'month' };
}

const PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'Everything' },
];

export function PeriodFilter({
  basePath,
  active,
  period,
  extraParams = {},
}: {
  basePath: string;
  active: PeriodPreset;
  period: Period;
  extraParams?: Record<string, string>;
}) {
  const extra = new URLSearchParams(extraParams).toString();
  const suffix = extra ? `&${extra}` : '';

  return (
    <div className="mb-4 space-y-3 no-print">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <Link key={preset.value} href={`${basePath}?period=${preset.value}${suffix}`}>
            <Button size="sm" variant={active === preset.value ? 'primary' : 'secondary'}>
              {preset.label}
            </Button>
          </Link>
        ))}
      </div>

      <form action={basePath} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="period" value="custom" />
        {Object.entries(extraParams).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-content-muted">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={period.from === '0000-01-01' ? '' : period.from}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-content-muted">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={period.to}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <Button type="submit" size="sm" variant={active === 'custom' ? 'primary' : 'secondary'}>
          Custom range
        </Button>
      </form>
    </div>
  );
}

/** Human description of the period, for a report header. */
export function describePeriod(period: Period, preset: PeriodPreset): string {
  if (preset === 'all') return `Everything up to ${formatDate(period.to)}`;
  if (period.from === period.to) return formatDate(period.from);
  return `${formatDate(period.from)} to ${formatDate(period.to)}`;
}
