'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { createUserAction } from '@/actions/user.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';
import { PermissionMatrix } from '@/components/shared/permission-matrix';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? 'Creating…' : 'Create the account'}
    </Button>
  );
}

export function NewUserForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createUserAction, {});
  const [role, setRole] = useState<'OWNER' | 'STAFF'>('STAFF');

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Their name"
            htmlFor="displayName"
            required
            error={state.fieldErrors?.['displayName']}
          >
            <TextInput
              id="displayName"
              name="displayName"
              autoComplete="name"
              required
              autoFocus
              invalid={Boolean(state.fieldErrors?.['displayName'])}
            />
          </Field>

          <Field
            label="Username"
            htmlFor="username"
            required
            hint="What they type to sign in."
            error={state.fieldErrors?.['username']}
          >
            <TextInput
              id="username"
              name="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              invalid={Boolean(state.fieldErrors?.['username'])}
            />
          </Field>

          <Field
            label="Starting password"
            htmlFor="password"
            required
            hint="They must choose their own the first time they sign in."
            error={state.fieldErrors?.['password']}
          >
            <TextInput
              id="password"
              name="password"
              type="text"
              autoComplete="off"
              required
              invalid={Boolean(state.fieldErrors?.['password'])}
            />
          </Field>

          <Field
            label="Till PIN (optional)"
            htmlFor="pin"
            hint="4–8 digits, for quickly switching at the till."
            error={state.fieldErrors?.['pin']}
          >
            <TextInput
              id="pin"
              name="pin"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 8351"
            />
          </Field>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">What kind of account?</h2>

        <div className="space-y-3">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="role"
              value="STAFF"
              checked={role === 'STAFF'}
              onChange={() => setRole('STAFF')}
              className="mt-1 h-4 w-4"
            />
            <span className="text-sm text-content">
              Staff
              <span className="mt-0.5 block text-xs text-content-subtle">
                Can only do what you tick below. This is the right choice for almost everyone.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="radio"
              name="role"
              value="OWNER"
              checked={role === 'OWNER'}
              onChange={() => setRole('OWNER')}
              className="mt-1 h-4 w-4"
            />
            <span className="text-sm text-content">
              Owner
              <span className="mt-0.5 block text-xs text-content-subtle">
                Full access to everything, including money, settings, closing the books and other
                people&rsquo;s accounts. Give this only to someone who owns the business.
              </span>
            </span>
          </label>
        </div>

        {role === 'OWNER' && (
          <Alert tone="warning" className="mt-4">
            An owner can do anything, including changing what everyone else can do and reopening
            closed periods. There is no way to limit an owner.
          </Alert>
        )}
      </div>

      {role === 'STAFF' && (
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <h2 className="mb-1 text-sm font-semibold text-content">What are they allowed to do?</h2>
          <p className="mb-4 text-sm text-content-muted">
            Start from a preset and adjust. You can change this at any time.
          </p>
          <PermissionMatrix initial={{}} />
        </div>
      )}

      <div className="flex items-center gap-3">
        <SubmitButton />
        <Link href="/users">
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
