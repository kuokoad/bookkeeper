'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';

import { createCategoryAction } from '@/actions/catalog.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Adding…' : 'Add category'}
    </Button>
  );
}

export function NewCategoryForm() {
  const [state, formAction] = useActionState<FormState, FormData>(createCategoryAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const succeeded = !state.error && !state.fieldErrors;

  // Clear the form after a successful add so the next one can be typed straight
  // away — this list is usually filled in one sitting.
  useEffect(() => {
    if (succeeded) formRef.current?.reset();
  }, [succeeded, state]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className="rounded-xl border border-line bg-surface-raised p-4"
      noValidate
    >
      {state.error && (
        <Alert tone="danger" className="mb-3">
          {state.error}
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <Field label="New category" htmlFor="name" required error={state.fieldErrors?.['name']}>
            <TextInput
              id="name"
              name="name"
              placeholder="e.g. Drinks"
              required
              autoComplete="off"
              invalid={Boolean(state.fieldErrors?.['name'])}
            />
          </Field>
        </div>
        <div className="min-w-[12rem] flex-1">
          <Field label="Description" htmlFor="description">
            <TextInput id="description" name="description" placeholder="Optional" autoComplete="off" />
          </Field>
        </div>
        <SubmitButton />
      </div>
    </form>
  );
}
