'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { changeOwnPasswordAction } from '@/actions/user.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth disabled={pending}>
      {pending ? 'Changing…' : 'Change my password'}
    </Button>
  );
}

export function ChangePasswordForm() {
  const [state, formAction] = useActionState<FormState, FormData>(changeOwnPasswordAction, {});

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Field
        label="Your current password"
        htmlFor="currentPassword"
        required
        error={state.fieldErrors?.['currentPassword']}
      >
        <TextInput
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          invalid={Boolean(state.fieldErrors?.['currentPassword'])}
        />
      </Field>

      <Field
        label="New password"
        htmlFor="newPassword"
        required
        hint="At least 8 characters. This protects the shop's money records."
        error={state.fieldErrors?.['newPassword']}
      >
        <TextInput
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          invalid={Boolean(state.fieldErrors?.['newPassword'])}
        />
      </Field>

      <Field
        label="New password again"
        htmlFor="confirmPassword"
        required
        error={state.fieldErrors?.['confirmPassword']}
      >
        <TextInput
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          invalid={Boolean(state.fieldErrors?.['confirmPassword'])}
        />
      </Field>

      <SubmitButton />
    </form>
  );
}
