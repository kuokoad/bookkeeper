import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Table primitives.
 *
 * Wrapped in a horizontally scrolling container so a wide stock table never
 * forces the whole page sideways on a phone.
 */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-xl border border-line bg-surface-raised',
        className,
      )}
    >
      <table className="w-full min-w-max border-collapse text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-line bg-surface-sunken text-left">
      <tr>{children}</tr>
    </thead>
  );
}

export function TH({
  children,
  numeric,
  className,
}: {
  children?: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-content-subtle',
        numeric && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn('border-b border-line last:border-0', className)}>{children}</tr>;
}

export function TD({
  children,
  numeric,
  className,
}: {
  children?: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td className={cn('px-3 py-2.5 align-middle', numeric && 'tabular text-right', className)}>
      {children}
    </td>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-content-muted">
        {children}
      </td>
    </tr>
  );
}
