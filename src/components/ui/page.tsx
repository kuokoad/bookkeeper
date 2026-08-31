import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/icon';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-content">{title}</h1>
        {description && <p className="mt-1 text-sm text-content-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  // Radius and shadow come from tokens rather than fixed utilities, so a look
  // can make a card sit on the page like paper on a desk without a second
  // component existing. The default look's tokens are today's values exactly.
  return (
    <section
      className={cn('border border-line bg-surface-raised p-4', className)}
      style={{ borderRadius: 'var(--card-radius)', boxShadow: 'var(--card-shadow)' }}
    >
      {title && <h2 className="mb-3 text-sm font-semibold text-content">{title}</h2>}
      {children}
    </section>
  );
}

/**
 * A single figure with its label. Amounts use tabular numerals.
 *
 * Shaped like the dashboard's cards: a quiet uppercase label above a figure
 * large enough to read from arm's length, and the explaining line below it
 * rather than beside it. The label is deliberately the smallest thing on the
 * card — what an owner scans for is the number, and the label only has to say
 * which number it is.
 *
 * `compact` is the same card with a smaller figure, for the secondary numbers
 * sitting under a headline one. It is a size, not a second style: same label,
 * same chrome, so a row of them still reads as one set.
 */
export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
  size = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  /**
   * Optional, and left off on purpose where nothing honest fits — there is no
   * picture of "Average expense" or "Showing". A row where one card has no
   * tile looks uneven; a card wearing a mark that means something else is
   * worse, because it is read rather than noticed.
   *
   * Decorative either way: the label says what the figure is.
   */
  icon?: IconName;
  size?: 'default' | 'compact';
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'success'
          ? 'text-success'
          : 'text-content';

  return (
    <div
      className="border border-line bg-surface-raised p-4"
      style={{ borderRadius: 'var(--card-radius)', boxShadow: 'var(--card-shadow)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
          {label}
        </p>
        {icon && (
          <span
            className={cn(
              'flex shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent',
              size === 'compact' ? 'h-7 w-7' : 'h-8 w-8',
            )}
            aria-hidden="true"
          >
            <Icon name={icon} className={size === 'compact' ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
          </span>
        )}
      </div>
      <p
        className={cn(
          'tabular mt-2 font-semibold',
          size === 'compact' ? 'text-lg' : 'text-2xl',
          toneClass,
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-content-muted">{hint}</p>}
    </div>
  );
}

/**
 * Empty states explain what to do next rather than showing a blank panel — a
 * shop owner opening Products for the first time needs a next step, not a void.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface-raised px-6 py-12 text-center">
      <p className="font-medium text-content">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-content-muted">{description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
