import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-content-muted border-line',
  success: 'bg-success-soft text-content border-success/40',
  warning: 'bg-warning-soft text-content border-warning/40',
  danger: 'bg-danger-soft text-content border-danger/40',
  accent: 'bg-accent-soft text-content border-accent/40',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
