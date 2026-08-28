import { cn } from '@/lib/cn';

/**
 * Charts, drawn as plain SVG on the server.
 *
 * No charting library, and no client JavaScript: these render to markup in the
 * same pass as the page. That matters on a counter PC and on a phone over shop
 * WiFi, and it keeps the runtime dependencies at eight.
 *
 * The rule that applies here as everywhere: **a component never computes
 * money.** Every chart is handed values that are already final, along with the
 * label already formatted by the server. The arithmetic below turns those
 * numbers into pixel positions and nothing else — no total is derived here, and
 * no figure shown to the owner is produced by this file.
 *
 * Each chart is `role="img"` with a written summary, because a shape alone
 * tells a screen reader nothing. The card around it always states the same
 * figures as text.
 */

export interface Datum {
  /** Axis label, e.g. a month or a day. */
  label: string;
  value: number;
}

/** The largest magnitude present, never zero, so a scale can divide by it. */
function scaleOf(values: number[]): number {
  const largest = Math.max(0, ...values.map((value) => Math.abs(value)));
  return largest === 0 ? 1 : largest;
}

// ---------------------------------------------------------------------------

/**
 * Paired bars — money in against money out, per period.
 *
 * Both series share one scale, or the taller of the two would be misleading:
 * bars of equal height meaning different amounts is the classic way a chart
 * lies without stating anything false.
 */
export function PairedBars({
  data,
  summary,
  className,
}: {
  data: { label: string; in: number; out: number }[];
  summary: string;
  className?: string;
}) {
  if (data.length === 0) return <EmptyChart className={className} />;

  const scale = scaleOf(data.flatMap((point) => [point.in, point.out]));
  const slot = 100 / data.length;
  const barWidth = Math.min(slot * 0.3, 6);

  return (
    <figure className={cn('m-0', className)}>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label={summary}
      >
        {data.map((point, index) => {
          const centre = slot * index + slot / 2;
          const inHeight = (Math.abs(point.in) / scale) * 34;
          const outHeight = (Math.abs(point.out) / scale) * 34;
          return (
            <g key={point.label}>
              <rect
                x={centre - barWidth - 0.6}
                y={36 - inHeight}
                width={barWidth}
                height={inHeight}
                rx="0.6"
                fill="var(--accent)"
              />
              <rect
                x={centre + 0.6}
                y={36 - outHeight}
                width={barWidth}
                height={outHeight}
                rx="0.6"
                fill="var(--border-strong)"
              />
            </g>
          );
        })}
        <line x1="0" y1="36" x2="100" y2="36" stroke="var(--border)" strokeWidth="0.3" />
      </svg>

      <div className="mt-1 flex justify-between text-[10px] text-content-subtle">
        {data.map((point) => (
          <span key={point.label} className="flex-1 truncate text-center">
            {point.label}
          </span>
        ))}
      </div>

      <figcaption className="mt-2 flex gap-4 text-xs text-content-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-accent" aria-hidden="true" /> Money in
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-line-strong" aria-hidden="true" /> Money out
        </span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------

/** A trend line with a soft fill beneath it. */
export function TrendLine({
  data,
  summary,
  className,
}: {
  data: Datum[];
  summary: string;
  className?: string;
}) {
  if (data.length < 2) return <EmptyChart className={className} />;

  const scale = scaleOf(data.map((point) => point.value));
  const step = 100 / (data.length - 1);
  const y = (value: number) => 34 - (Math.max(0, value) / scale) * 30;

  const points = data.map((point, index) => `${index * step},${y(point.value)}`);
  const line = `M ${points.join(' L ')}`;
  const area = `${line} L 100,36 L 0,36 Z`;

  return (
    <figure className={cn('m-0', className)}>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="h-28 w-full"
        role="img"
        aria-label={summary}
      >
        <path d={area} fill="var(--accent-soft)" />
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          // Without this the stroke is stretched by preserveAspectRatio="none".
          vectorEffect="non-scaling-stroke"
        />
        <line x1="0" y1="36" x2="100" y2="36" stroke="var(--border)" strokeWidth="0.3" />
      </svg>

      <div className="mt-1 flex justify-between text-[10px] text-content-subtle">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------

export interface Slice {
  label: string;
  value: number;
  /** Formatted by the server. Never derived here. */
  display: string;
}

/**
 * A ring, for a breakdown of one total.
 *
 * Drawn with stroke-dasharray on a circle rather than arc paths: fewer moving
 * parts, and no trigonometry to get subtly wrong at the seams.
 */
export function Donut({
  slices,
  summary,
  className,
}: {
  slices: Slice[];
  summary: string;
  className?: string;
}) {
  const total = slices.reduce((running, slice) => running + Math.max(0, slice.value), 0);
  if (total <= 0) return <EmptyChart className={className} />;

  const RADIUS = 15.9155; // circumference 100, so a slice's length IS its percent
  // Role tokens, not the brand ramp directly. Every other mark in this file
  // already reads --accent and --border-strong, so the donut was the one thing
  // that stayed emerald when the shop switched to a warm look. The default's
  // values are that same ramp, so nothing changes for a shop that has not.
  const palette = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
    'var(--border-strong)',
  ];

  // Each slice's start is the sum of the ones before it, computed without
  // mutating anything during render. Quadratic, over at most six slices.
  const percents = slices.map((slice) => (Math.max(0, slice.value) / total) * 100);
  const segments = slices.map((slice, index) => ({
    slice,
    index,
    percent: percents[index] ?? 0,
    start: percents.slice(0, index).reduce((running, percent) => running + percent, 0),
  }));

  return (
    <figure className={cn('m-0 flex items-center gap-4', className)}>
      <svg viewBox="0 0 40 40" className="h-24 w-24 shrink-0" role="img" aria-label={summary}>
        <circle cx="20" cy="20" r={RADIUS} fill="none" stroke="var(--surface-sunken)" strokeWidth="6" />
        {segments.map(({ slice, index, percent, start }) => {
          const dash = `${percent} ${100 - percent}`;
          // -25 puts the first slice at twelve o'clock rather than three.
          const rotation = -25 + start;
          return (
            <circle
              key={slice.label}
              cx="20"
              cy="20"
              r={RADIUS}
              fill="none"
              stroke={palette[index % palette.length]}
              strokeWidth="6"
              strokeDasharray={dash}
              strokeDashoffset={-rotation}
              transform="rotate(-90 20 20)"
            />
          );
        })}
      </svg>

      <figcaption className="min-w-0 flex-1 space-y-1.5">
        {slices.map((slice, index) => (
          <span key={slice.label} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: palette[index % palette.length] }}
              aria-hidden="true"
            />
            <span className="tabular font-medium text-content">{slice.display}</span>
            <span className="truncate text-content-muted">{slice.label}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------

/**
 * A single bar split into parts, for showing a total's composition —
 * what is overdue against what is not yet due, say.
 */
export function SplitBar({
  parts,
  summary,
  className,
}: {
  parts: { label: string; value: number; tone: 'accent' | 'warning' | 'danger' | 'muted' }[];
  summary: string;
  className?: string;
}) {
  const total = parts.reduce((running, part) => running + Math.max(0, part.value), 0);

  const TONES = {
    accent: 'bg-accent',
    warning: 'bg-warning',
    danger: 'bg-danger',
    muted: 'bg-line-strong',
  } as const;

  return (
    <div className={cn('flex h-2 overflow-hidden rounded-full bg-surface-sunken', className)} role="img" aria-label={summary}>
      {total > 0 &&
        parts.map((part) => (
          <span
            key={part.label}
            className={TONES[part.tone]}
            style={{ width: `${(Math.max(0, part.value) / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Shown when there is genuinely nothing to plot.
 *
 * Deliberately says so rather than drawing a flat line at zero, which would
 * read as a real measurement of nothing happening.
 */
function EmptyChart({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex h-28 items-center justify-center rounded-lg border border-dashed border-line text-xs text-content-subtle',
        className,
      )}
    >
      Nothing recorded for this period
    </div>
  );
}
