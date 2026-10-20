'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';

import { deleteUnitAction, saveUnitAction } from '@/actions/catalog.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';
import { Select } from '@/components/ui/select';

interface UnitValues {
  symbol: string;
  name: string;
  decimalPlaces: number;
  productCount: number;
}

function SubmitButton({ adding }: { adding: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={adding ? 'primary' : 'secondary'}>
      {pending ? 'Saving…' : adding ? 'Add unit' : 'Save'}
    </Button>
  );
}

/** Adds a unit when `unit` is null; otherwise edits that one in place. */
export function UnitForm({ unit }: { unit: UnitValues | null }) {
  const adding = unit === null;
  const [state, formAction] = useActionState<FormState, FormData>(
    saveUnitAction.bind(null, unit?.symbol ?? null),
    {},
  );
  const [deleteState, deleteAction] = useActionState<FormState, FormData>(
    deleteUnitAction.bind(null, unit?.symbol ?? ''),
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const succeeded = !state.error && !state.fieldErrors;

  // Clear the add form after a success so the next unit can be typed straight away.
  useEffect(() => {
    if (adding && succeeded) formRef.current?.reset();
  }, [adding, succeeded, state]);

  const id = (field: string) => `${field}-${unit?.symbol ?? 'new'}`;
  const error = state.error ?? deleteState.error;

  return (
    <form
      ref={formRef}
      action={formAction}
      className="rounded-xl border border-line bg-surface-raised p-4"
      noValidate
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-32">
          <Field label={adding ? 'New unit' : 'Symbol'} htmlFor={id('symbol')} required error={state.fieldErrors?.['symbol']}>
            <TextInput
              id={id('symbol')}
              name="symbol"
              defaultValue={unit?.symbol ?? ''}
              placeholder="e.g. Carton"
              required
              autoComplete="off"
              invalid={Boolean(state.fieldErrors?.['symbol'])}
            />
          </Field>
        </div>
        <div className="min-w-[10rem] flex-1">
          <Field label="Name" htmlFor={id('name')} required error={state.fieldErrors?.['name']}>
            <TextInput
              id={id('name')}
              name="name"
              defaultValue={unit?.name ?? ''}
              placeholder="e.g. Carton"
              required
              autoComplete="off"
              invalid={Boolean(state.fieldErrors?.['name'])}
            />
          </Field>
        </div>
        <div className="w-40">
          <Field label="Decimal places" htmlFor={id('decimalPlaces')}>
            <Select
              id={id('decimalPlaces')}
              name="decimalPlaces"
              defaultValue={String(unit?.decimalPlaces ?? 0)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              <option value="0">0 (whole)</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </Select>
          </Field>
        </div>
        <SubmitButton adding={adding} />
        {!adding && (
          <>
            <span className="tabular w-20 pb-3 text-xs text-content-subtle">
              {unit.productCount} product{unit.productCount === 1 ? '' : 's'}
            </span>
            {unit.productCount === 0 && (
              <Button type="submit" variant="ghost" formAction={deleteAction}>
                Delete
              </Button>
            )}
          </>
        )}
      </div>
    </form>
  );
}
