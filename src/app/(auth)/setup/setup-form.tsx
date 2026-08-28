'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { setupOwnerAction, type FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { BUSINESS_TYPES, BUSINESS_TYPE_LABELS } from '@/lib/business-type';

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

      <fieldset>
        <legend className="mb-1 block text-sm font-medium text-content">
          What kind of shop is it?
        </legend>
        <p className="mb-3 text-sm text-content-muted">
          You can change this later in Settings. It only decides what you are shown &mdash; nothing
          you record is ever hidden by it.
        </p>
        <div className="space-y-2">
          {BUSINESS_TYPES.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer gap-3 rounded-xl border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name="businessType"
                value={option}
                defaultChecked={option === 'general_retail'}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-content">
                  {BUSINESS_TYPE_LABELS[option].name}
                </span>
                <span className="mt-0.5 block text-xs text-content-muted">
                  {BUSINESS_TYPE_LABELS[option].blurb}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

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
