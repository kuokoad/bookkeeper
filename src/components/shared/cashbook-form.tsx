'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';
import { DateField } from '@/components/ui/date-field';

export interface Option {
  id: number;
  name: string;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

/**
 * Recording money out (an expense) or money in (other income).
 *
 * One component for both because they ask for exactly the same six things —
 * the only difference is the wording and which list of categories is offered.
 */
export function CashbookForm({
  action,
  categories,
  accounts,
  today,
  currencyCode,
  submitLabel,
  categoryLabel,
  accountLabel,
  amountLabel,
  descriptionPlaceholder,
  emptyCategoriesHint,
  returnTo,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  categories: Option[];
  accounts: (Option & { isDefault: boolean })[];
  today: string;
  currencyCode: string;
  submitLabel: string;
  categoryLabel: string;
  accountLabel: string;
  amountLabel: string;
  descriptionPlaceholder: string;
  emptyCategoriesHint: string;
  /**
   * The filters the list was showing, so recording an entry comes back to
   * them. Without it every entry throws the owner back to an unfiltered page.
   */
  returnTo?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [amount, setAmount] = useState('');

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="returnTo" value={returnTo ?? ''} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Date"
            htmlFor="businessDate"
            required
            error={state.fieldErrors?.['businessDate']}
          >
            <DateField
              id="businessDate"
              name="businessDate"
              defaultValue={today}
              required
            />
          </Field>

          <Field
            label={categoryLabel}
            htmlFor="categoryAccountId"
            required
            hint={categories.length === 0 ? emptyCategoriesHint : undefined}
            error={state.fieldErrors?.['categoryAccountId']}
          >
            <select
              id="categoryAccountId"
              name="categoryAccountId"
              required
              disabled={categories.length === 0}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content disabled:opacity-60"
            >
              <option value="">Choose…</option>
              {categories.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="sm:col-span-2">
            <Field
              label="Description"
              htmlFor="description"
              required
              error={state.fieldErrors?.['description']}
            >
              <TextInput
                id="description"
                name="description"
                placeholder={descriptionPlaceholder}
                required
                autoFocus
                invalid={Boolean(state.fieldErrors?.['description'])}
              />
            </Field>
          </div>

          <Field
            label={`${amountLabel} (${currencyCode})`}
            htmlFor="amount"
            required
            error={state.fieldErrors?.['amount']}
          >
            <AmountInput
              id="amount"
              name="amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              required
              invalid={Boolean(state.fieldErrors?.['amount'])}
            />
          </Field>

          <Field
            label={accountLabel}
            htmlFor="paymentAccountId"
            required
            error={state.fieldErrors?.['paymentAccountId']}
          >
            <select
              id="paymentAccountId"
              name="paymentAccountId"
              defaultValue={String(accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id ?? '')}
              required
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              {accounts.map((account) => (
                <option key={account.id} value={String(account.id)}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reference" htmlFor="reference" hint="Receipt or transaction number.">
            <TextInput id="reference" name="reference" placeholder="Optional" />
          </Field>

          <Field label="Note" htmlFor="note">
            <TextInput id="note" name="note" placeholder="Optional" />
          </Field>
        </div>
      </div>

      <SubmitButton label={submitLabel} />
    </form>
  );
}

/** Inline "add a category" form, used on both the expense and income pages. */
export function AddCategoryForm({
  action,
  label,
  placeholder,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  placeholder: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + Add a category
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2" noValidate>
      <div className="min-w-[12rem]">
        <Field label={label} htmlFor="new-category" error={state.fieldErrors?.['name']}>
          <TextInput
            id="new-category"
            name="name"
            placeholder={placeholder}
            autoFocus
            className="h-10"
            invalid={Boolean(state.fieldErrors?.['name'])}
          />
        </Field>
      </div>
      <Button type="submit" size="sm">
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {state.error && (
        <Alert tone="danger" className="w-full">
          {state.error}
        </Alert>
      )}
    </form>
  );
}
