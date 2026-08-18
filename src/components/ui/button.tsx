import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-text hover:opacity-90 border-transparent',
  secondary:
    'bg-surface-raised text-content border-line-strong hover:bg-surface-sunken',
  ghost: 'bg-transparent text-content-muted border-transparent hover:bg-surface-sunken',
  danger: 'bg-danger text-white hover:opacity-90 border-transparent',
};

const SIZES: Record<Size, string> = {
  // Touch targets stay >= 44px on md/lg: staff use this on a phone, fast.
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border font-medium',
        // A press should feel like a press. Kept to 2% so it reads on a touchscreen
        // without looking like the button is shrinking away from the finger.
        'transition-[colors,transform] duration-120 active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
