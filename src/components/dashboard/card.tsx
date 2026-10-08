import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/icon';

export function DashboardCard({
  title,
  icon,
  children,
  href,
  period,
  embedded = false,
}: {
  title: string;
  icon: IconName;
  children: ReactNode;
  href?: string;
  period?: string;
  embedded?: boolean;
}) {
  return (
    <section
      className={
        embedded
          ? 'min-w-0'
          : 'min-w-0 border border-line bg-surface-raised p-4'
      }
      style={{
        borderRadius: 'var(--card-radius)',
        boxShadow: embedded ? undefined : 'var(--card-shadow)',
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-content">
          {href ? (
            <Link
              href={href}
              className="rounded hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
            >
              {title}
            </Link>
          ) : (
            title
          )}
        </h3>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon name={icon} className="h-4 w-4" />
        </span>
      </div>
      {period && <p className="mb-2 text-xs text-content-muted">{period}</p>}
      {children}
    </section>
  );
}

export function DashboardFigure({
  value,
  hint,
  negative = false,
}: {
  value: string;
  hint: string;
  negative?: boolean;
}) {
  return (
    <div>
      <p
        className={`tabular break-words text-2xl font-semibold ${negative ? 'text-danger' : 'text-content'}`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-content-muted">{hint}</p>
    </div>
  );
}
