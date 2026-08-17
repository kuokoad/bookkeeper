import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: ReactNode;
}

/**
 * Label + control + hint/error, wired for screen readers.
 * The error is rendered in an aria-live region so it is announced when it
 * appears after a failed submission.
 */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-content">
        {label}
        {required && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-content-subtle">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** React 19 passes `ref` as an ordinary prop — no forwardRef needed. */
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({ className, invalid, ...props }: TextInputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${props.id}-error` : undefined}
      className={cn(
        'h-11 w-full rounded-lg border bg-surface-raised px-3 text-content',
        'placeholder:text-content-subtle',
        'focus:outline-none focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-danger' : 'border-line-strong',
        className,
      )}
      {...props}
    />
  );
}

/** Right-aligned tabular input for money and quantity entry. */
export function AmountInput({ className, ...props }: TextInputProps) {
  return (
    <TextInput
      inputMode="decimal"
      autoComplete="off"
      className={cn('tabular text-right', className)}
      {...props}
    />
  );
}
