'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { setupOwnerAction, type FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" fullWidth disabled={pending}>
      {pending ? 'Creating your account…' : 'Create owner account'}
    </Button>
  );
}

export function SetupForm() {
  const [state, formAction] = useActionState<FormState, FormData>(setupOwnerAction, {});

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <Field
        label="Shop name"
        htmlFor="businessName"
        required
        hint="Appears on receipts and reports. You can change it later in Settings."
        error={state.fieldErrors?.['businessName']}
      >
        <TextInput
          id="businessName"
          name="businessName"
          autoFocus
          required
          invalid={Boolean(state.fieldErrors?.['businessName'])}
        />
      </Field>

      <Field
        label="Your name"
        htmlFor="displayName"
        required
        error={state.fieldErrors?.['displayName']}
      >
        <TextInput
          id="displayName"
          name="displayName"
          autoComplete="name"
          required
          invalid={Boolean(state.fieldErrors?.['displayName'])}
        />
      </Field>

      <Field
        label="Username"
        htmlFor="username"
        required
        hint="What you will type to sign in."
        error={state.fieldErrors?.['username']}
      >
        <TextInput
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          invalid={Boolean(state.fieldErrors?.['username'])}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        hint="At least 8 characters. This protects your money records — do not share it."
        error={state.fieldErrors?.['password']}
      >
        <TextInput
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          invalid={Boolean(state.fieldErrors?.['password'])}
        />
      </Field>

      <Field
        label="Confirm password"
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
