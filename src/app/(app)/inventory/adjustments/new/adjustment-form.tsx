'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { createAdjustmentAction } from '@/actions/inventory.actions';
import type { FormState } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';

export interface ProductOption {
  id: number;
  name: string;
  unit: string;
  qtyOnHandLabel: string;
}

export interface ReasonOption {
  value: string;
  label: string;
  /** 'IN', 'OUT', or null when the reason can go either way. */
  defaultDirection: string | null;
}

interface Row {
  key: number;
  productId: string;
  direction: 'IN' | 'OUT';
  qty: string;
  value: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? 'Saving…' : 'Save adjustment'}
    </Button>
  );
}

export function AdjustmentForm({
  products,
  reasons,
  today,
  currencyCode,
}: {
  products: ProductOption[];
  reasons: ReasonOption[];
  today: string;
  currencyCode: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(createAdjustmentAction, {});
  const [reason, setReason] = useState(reasons[0]?.value ?? 'COUNT_CORRECTION');
  const [rows, setRows] = useState<Row[]>([
    { key: 1, productId: '', direction: 'IN', qty: '', value: '' },
  ]);

  const selectedReason = reasons.find((option) => option.value === reason);
  const forcedDirection = selectedReason?.defaultDirection ?? null;

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        key: Math.max(0, ...current.map((row) => row.key)) + 1,
        productId: '',
        direction: (forcedDirection as 'IN' | 'OUT') ?? 'OUT',
        qty: '',
        value: '',
      },
    ]);
  }

  function removeRow(key: number) {
    setRows((current) => (current.length === 1 ? current : current.filter((row) => row.key !== key)));
  }

  function onReasonChange(next: string) {
    setReason(next);
    const direction = reasons.find((option) => option.value === next)?.defaultDirection;
    if (direction === 'IN' || direction === 'OUT') {
      setRows((current) => current.map((row) => ({ ...row, direction })));
    }
  }

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" htmlFor="businessDate" required error={state.fieldErrors?.['businessDate']}>
            <TextInput
              id="businessDate"
              name="businessDate"
              type="date"
              defaultValue={today}
              required
              invalid={Boolean(state.fieldErrors?.['businessDate'])}
            />
          </Field>

          <Field label="Reason" htmlFor="reason" required error={state.fieldErrors?.['reason']}>
            <select
              id="reason"
              name="reason"
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              {reasons.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="sm:col-span-2">
            <Field label="Note" htmlFor="note" hint="Optional, but future-you will thank you.">
              <TextInput id="note" name="note" placeholder="e.g. Crate dropped during delivery" />
            </Field>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">Products</h2>

        <div className="space-y-3">
          {rows.map((row, index) => (
            <div
              key={row.key}
              className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-12"
            >
              <div className="sm:col-span-5">
                <label
                  htmlFor={`product-${row.key}`}
                  className="mb-1 block text-xs font-medium text-content-muted"
                >
                  Product
                </label>
                <select
                  id={`product-${row.key}`}
                  name="productId"
                  value={row.productId}
                  onChange={(event) => updateRow(row.key, { productId: event.target.value })}
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
                >
                  <option value="">Choose a product…</option>
                  {products.map((product) => (
                    <option key={product.id} value={String(product.id)}>
                      {product.name} ({product.qtyOnHandLabel})
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor={`direction-${row.key}`}
                  className="mb-1 block text-xs font-medium text-content-muted"
                >
                  Direction
                </label>
                <select
                  id={`direction-${row.key}`}
                  name="direction"
                  value={row.direction}
                  disabled={forcedDirection !== null}
                  onChange={(event) =>
                    updateRow(row.key, { direction: event.target.value as 'IN' | 'OUT' })
                  }
                  className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content disabled:opacity-60"
                >
                  <option value="IN">Stock in</option>
                  <option value="OUT">Stock out</option>
                </select>
                {/* A disabled select posts nothing, so mirror the value. */}
                {forcedDirection !== null && (
                  <input type="hidden" name="direction" value={row.direction} />
                )}
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor={`qty-${row.key}`}
                  className="mb-1 block text-xs font-medium text-content-muted"
                >
                  Quantity
                </label>
                <AmountInput
                  id={`qty-${row.key}`}
                  name="qty"
                  value={row.qty}
                  onChange={(event) => updateRow(row.key, { qty: event.target.value })}
                  placeholder="0"
                />
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor={`value-${row.key}`}
                  className="mb-1 block text-xs font-medium text-content-muted"
                >
                  Total value
                </label>
                <AmountInput
                  id={`value-${row.key}`}
                  name="value"
                  value={row.direction === 'IN' ? row.value : ''}
                  disabled={row.direction === 'OUT'}
                  onChange={(event) => updateRow(row.key, { value: event.target.value })}
                  placeholder={row.direction === 'OUT' ? 'Automatic' : '0.00'}
                />
                {/* Keep the parallel arrays aligned when the field is disabled. */}
                {row.direction === 'OUT' && <input type="hidden" name="value" value="" />}
              </div>

              <div className="flex items-end sm:col-span-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                  aria-label={`Remove line ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" onClick={addRow}>
            Add another product
          </Button>
        </div>

        <Alert tone="info" className="mt-4">
          When stock goes <strong>out</strong>, its value is calculated automatically from the
          weighted average cost — you never type it. When stock comes <strong>in</strong>, enter the
          total {currencyCode} value of the goods so inventory and the accounts stay in step.
        </Alert>
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton />
        <Link href="/inventory">
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </Link>
      </div>
    </form>
  );
}
