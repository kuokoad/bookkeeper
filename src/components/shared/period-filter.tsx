import { formatDate } from '@/lib/format';
import {
  DATE_PRESET_LABELS,
  EARLIEST_DATE,
  resolveDateRange,
  type DatePreset,
  type DateRange,
} from '@/lib/filters';

/**
 * The report period, expressed in the vocabulary the reports already use.
 *
 * The date arithmetic itself lives in `@/lib/filters`, shared with every list
 * page, so a report and a list asked for "last month" can never disagree about
 * which days that is. What stays here is the reports' own naming.
 */

export type Period = DateRange;
export type PeriodPreset = DatePreset;

export function resolvePeriod(
  preset: string | undefined,
  from: string | undefined,
  to: string | undefined,
  today: string,
): { period: Period; preset: PeriodPreset } {
  const resolved = resolveDateRange(preset, from, to, today);
  return { period: resolved.range, preset: resolved.preset };
}

/** Human description of the period, for a report header. */
export function describePeriod(period: Period, preset: PeriodPreset): string {
  if (preset === 'all') return `Everything up to ${formatDate(period.to)}`;
  if (period.from === period.to) return formatDate(period.from);
  if (period.from === EARLIEST_DATE) return `Up to ${formatDate(period.to)}`;
  return `${formatDate(period.from)} to ${formatDate(period.to)}`;
}

export { DATE_PRESET_LABELS };
