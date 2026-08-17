import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  info: 'bg-surface-sunken border-line-strong text-content',
  success: 'bg-success-soft border-success/40 text-content',
  warning: 'bg-warning-soft border-warning/40 text-content',
  danger: 'bg-danger-soft border-danger/40 text-content',
};

export interface AlertProps {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Errors are shown, never swallowed. `danger` and `warning` announce themselves
 * to assistive technology because they usually appear after a failed action.
 */
export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  const assertive = tone === 'danger' || tone === 'warning';
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm', TONES[tone], className)}
    >
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      <div className="text-content-muted">{children}</div>
    </div>
  );
}
