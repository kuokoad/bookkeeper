import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

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

/** A single figure with its label. Amounts use tabular numerals. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
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
      <p className="text-sm text-content-muted">{label}</p>
      <p className={cn('tabular mt-1 text-xl font-semibold', toneClass)}>{value}</p>
      {hint && <p className="mt-1 text-xs text-content-subtle">{hint}</p>}
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
