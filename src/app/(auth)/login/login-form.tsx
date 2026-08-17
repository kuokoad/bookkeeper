'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { loginAction, pinLoginAction, type FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth disabled={pending}>
      {pending ? 'Signing in…' : label}
    </Button>
  );
}

function PasswordForm() {
  const [state, formAction] = useActionState<FormState, FormData>(loginAction, {});

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Field label="Username" htmlFor="username" required error={state.fieldErrors?.['username']}>
        <TextInput
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          invalid={Boolean(state.fieldErrors?.['username'])}
        />
      </Field>

      <Field label="Password" htmlFor="password" required error={state.fieldErrors?.['password']}>
        <TextInput
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          invalid={Boolean(state.fieldErrors?.['password'])}
        />
      </Field>

      <SubmitButton label="Sign in" />
    </form>
  );
}

function PinForm() {
  const [state, formAction] = useActionState<FormState, FormData>(pinLoginAction, {});

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Field
        label="Username"
        htmlFor="pin-username"
        required
        error={state.fieldErrors?.['username']}
      >
        <TextInput
          id="pin-username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          invalid={Boolean(state.fieldErrors?.['username'])}
        />
      </Field>

      <Field label="Till PIN" htmlFor="pin" required error={state.fieldErrors?.['pin']}>
        <TextInput
          id="pin"
          name="pin"
          type="password"
          // A numeric keypad on the touchscreen at the counter, which is the
          // whole point of signing in this way.
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={8}
          required
          invalid={Boolean(state.fieldErrors?.['pin'])}
        />
      </Field>

      <SubmitButton label="Sign in with PIN" />
    </form>
  );
}

/**
 * Two ways in, one account.
 *
 * The PIN is for the counter machine, where typing a full password in front of
 * a queue is impractical. Only people an owner has given a PIN to can use it;
 * everyone else uses their password. Both go through the same throttle and the
 * same account lockout on the server.
 */
export function LoginForm() {
  const [mode, setMode] = useState<'password' | 'pin'>('password');

  return (
    <div>
      <div
        role="tablist"
        aria-label="How to sign in"
        className="mb-6 grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface-sunken p-1"
      >
        {(['password', 'pin'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={
              mode === value
                ? 'rounded-md bg-surface-raised px-3 py-2 text-sm font-medium text-content shadow-sm'
                : 'rounded-md px-3 py-2 text-sm font-medium text-content-muted hover:text-content'
            }
          >
            {value === 'password' ? 'Password' : 'Till PIN'}
          </button>
        ))}
      </div>

      {mode === 'password' ? <PasswordForm /> : <PinForm />}
    </div>
  );
}
