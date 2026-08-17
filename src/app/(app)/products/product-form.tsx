'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';

export interface ProductFormValues {
  name: string;
  sku: string;
  barcode: string;
  categoryId: string;
  unit: string;
  description: string;
  costPrice: string;
  sellingPrice: string;
  minStock: string;
  trackInventory: boolean;
}

export interface CategoryOption {
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

export function ProductForm({
  action,
  categories,
  initial,
  submitLabel,
  currencyCode,
  showStockNotice,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  categories: CategoryOption[];
  initial: ProductFormValues;
  submitLabel: string;
  currencyCode: string;
  showStockNotice: boolean;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Product name" htmlFor="name" required error={state.fieldErrors?.['name']}>
              <TextInput
                id="name"
                name="name"
                defaultValue={initial.name}
                required
                autoFocus
                invalid={Boolean(state.fieldErrors?.['name'])}
              />
            </Field>
          </div>

          <Field
            label="Category"
            htmlFor="categoryId"
            hint="Optional. Manage the list under Categories."
          >
            <select
              id="categoryId"
              name="categoryId"
              defaultValue={initial.categoryId}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              <option value="">No category</option>
              {categories.map((option) => (
                <option key={option.id} value={String(option.id)}>
                  {option.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Unit"
            htmlFor="unit"
            required
            hint="pcs, kg, crate, bag — whatever you sell it by."
            error={state.fieldErrors?.['unit']}
          >
            <TextInput
              id="unit"
              name="unit"
              defaultValue={initial.unit}
              required
              invalid={Boolean(state.fieldErrors?.['unit'])}
            />
          </Field>

          <Field label="SKU" htmlFor="sku" hint="Optional short code." error={state.fieldErrors?.['sku']}>
            <TextInput id="sku" name="sku" defaultValue={initial.sku} autoComplete="off" />
          </Field>

          <Field
            label="Barcode"
            htmlFor="barcode"
            hint="Optional. Used for fast scanning at the till."
            error={state.fieldErrors?.['barcode']}
          >
            <TextInput
              id="barcode"
              name="barcode"
              defaultValue={initial.barcode}
              autoComplete="off"
              inputMode="numeric"
            />
          </Field>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">Prices</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={`Cost price (${currencyCode})`}
            htmlFor="costPrice"
            required
            hint="What you expect to pay. Used to pre-fill purchases only — it never changes past profit."
            error={state.fieldErrors?.['costPrice']}
          >
            <AmountInput
              id="costPrice"
              name="costPrice"
              defaultValue={initial.costPrice}
              required
              invalid={Boolean(state.fieldErrors?.['costPrice'])}
            />
          </Field>

          <Field
            label={`Selling price (${currencyCode})`}
            htmlFor="sellingPrice"
            required
            error={state.fieldErrors?.['sellingPrice']}
          >
            <AmountInput
              id="sellingPrice"
              name="sellingPrice"
              defaultValue={initial.sellingPrice}
              required
              invalid={Boolean(state.fieldErrors?.['sellingPrice'])}
            />
          </Field>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">Stock</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Reorder level"
            htmlFor="minStock"
            hint="Warn me when stock falls to this. Leave blank to use the shop default."
            error={state.fieldErrors?.['minStock']}
          >
            <AmountInput
              id="minStock"
              name="minStock"
              defaultValue={initial.minStock}
              invalid={Boolean(state.fieldErrors?.['minStock'])}
            />
          </Field>

          <div className="flex items-start gap-3 pt-7">
            <input
              id="trackInventory"
              name="trackInventory"
              type="checkbox"
              defaultChecked={initial.trackInventory}
              className="mt-0.5 h-4 w-4 rounded border-line-strong"
            />
            <label htmlFor="trackInventory" className="text-sm text-content">
              Track stock for this product
              <span className="mt-0.5 block text-xs text-content-subtle">
                Turn off for services or anything you do not count.
              </span>
            </label>
          </div>
        </div>

        {showStockNotice && (
          <Alert tone="info" className="mt-4">
            Stock quantity is not set here. A new product starts empty; enter opening stock with a
            stock adjustment so the value can always be traced back to a record.
          </Alert>
        )}
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton label={submitLabel} />
        <Link href="/products">
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
