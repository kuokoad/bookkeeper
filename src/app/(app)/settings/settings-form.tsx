'use client';

import { useActionState, useId, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { updateSettingsAction } from '@/actions/settings.actions';
import type { FormState } from '@/actions/auth.actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Card } from '@/components/ui/page';

export interface SettingsFormValues {
  businessName: string;
  address: string;
  phone: string;
  email: string;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  /** Percentage as typed, e.g. "12.5". Converted to basis points on the server. */
  taxRate: string;
  taxInclusive: boolean;
  taxLabel: string;
  /** Whole units as typed, e.g. "5" or "2.5". */
  lowStock: string;
  allowNegativeStock: boolean;
  allowOverpayment: boolean;
  financialYearStartMonth: number;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save settings'}
    </Button>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        {...(checked !== undefined ? { checked } : {})}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        className="mt-1 h-4 w-4 shrink-0 rounded border-line-strong accent-[var(--accent)]"
      />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-content">{label}</span>
        <span className="mt-0.5 block text-content-muted">{hint}</span>
      </label>
    </div>
  );
}

/**
 * The shop's settings.
 *
 * Tax and stock policy change how money is recorded, so each carries a plain
 * statement of what changing it will and will not do — in particular that a
 * change applies to what happens next and never rewrites what is already in the
 * books.
 */
export function SettingsForm({
  values,
  currencyLocked,
}: {
  values: SettingsFormValues;
  /** True once there are transactions: the currency then labels real history. */
  currencyLocked: boolean;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(updateSettingsAction, {});
  const [taxEnabled, setTaxEnabled] = useState(values.taxEnabled);

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.success && <Alert tone="success">{state.success}</Alert>}

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Your shop</h2>
        <p className="mb-4 text-sm text-content-muted">
          This is what appears at the top of receipts and reports.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              label="Shop name"
              htmlFor="businessName"
              required
              error={state.fieldErrors?.['businessName']}
            >
              <TextInput
                id="businessName"
                name="businessName"
                defaultValue={values.businessName}
                required
                invalid={Boolean(state.fieldErrors?.['businessName'])}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field label="Address" htmlFor="address" error={state.fieldErrors?.['address']}>
              <TextInput id="address" name="address" defaultValue={values.address} />
            </Field>
          </div>

          <Field label="Phone" htmlFor="phone" error={state.fieldErrors?.['phone']}>
            <TextInput id="phone" name="phone" type="tel" defaultValue={values.phone} />
          </Field>

          <Field label="Email" htmlFor="email" error={state.fieldErrors?.['email']}>
            <TextInput
              id="email"
              name="email"
              type="email"
              defaultValue={values.email}
              invalid={Boolean(state.fieldErrors?.['email'])}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Currency</h2>

        {currencyLocked ? (
          <Alert tone="info" className="mb-4">
            The currency is fixed at <strong>{values.currencyCode}</strong> because there are
            already transactions in the books. Every amount recorded is in that currency, so
            changing it would misstate your history rather than convert it. The symbol can still be
            adjusted.
          </Alert>
        ) : (
          <p className="mb-4 text-sm text-content-muted">
            Set this before you start trading. Once there are transactions it is fixed, because
            every amount recorded is in this currency.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Currency code"
            htmlFor="currencyCode"
            hint="Three letters, like GHS or NGN."
            required
            error={state.fieldErrors?.['currencyCode']}
          >
            <TextInput
              id="currencyCode"
              name="currencyCode"
              defaultValue={values.currencyCode}
              maxLength={3}
              autoCapitalize="characters"
              readOnly={currencyLocked}
              // Read-only rather than disabled: a disabled input is not
              // submitted, and the server would read it as a change to blank.
              className={currencyLocked ? 'cursor-not-allowed opacity-60' : undefined}
              required
              invalid={Boolean(state.fieldErrors?.['currencyCode'])}
            />
          </Field>

          <Field
            label="Symbol"
            htmlFor="currencySymbol"
            hint="Shown beside amounts on receipts."
            required
            error={state.fieldErrors?.['currencySymbol']}
          >
            <TextInput
              id="currencySymbol"
              name="currencySymbol"
              defaultValue={values.currencySymbol}
              maxLength={8}
              required
              invalid={Boolean(state.fieldErrors?.['currencySymbol'])}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Tax</h2>
        <p className="mb-4 text-sm text-content-muted">
          Changing any of this affects sales recorded from now on. Sales already in the books keep
          the tax they were recorded with.
        </p>

        <div className="space-y-4">
          <Toggle
            name="taxEnabled"
            label="Charge tax on sales"
            hint="When off, no tax is calculated or posted."
            checked={taxEnabled}
            onChange={setTaxEnabled}
          />

          {/*
            Hidden rather than unmounted. An unmounted input submits nothing, so
            saving with tax switched off would send no tax name at all — failing
            validation on a field nobody can see — and would quietly reset
            "prices include tax" to off. Kept in the DOM, the stored values ride
            along untouched.
          */}
          <div
            hidden={!taxEnabled}
            className="grid gap-4 border-l-2 border-line pl-4 sm:grid-cols-2"
          >
              <Field
                label="Rate"
                htmlFor="taxRate"
                hint="A percentage, like 12.5"
                required
                error={state.fieldErrors?.['taxRate']}
              >
                <TextInput
                  id="taxRate"
                  name="taxRate"
                  inputMode="decimal"
                  defaultValue={values.taxRate}
                  className="tabular"
                  invalid={Boolean(state.fieldErrors?.['taxRate'])}
                />
              </Field>

              <Field
                label="What it is called"
                htmlFor="taxLabel"
                hint="Appears on receipts, e.g. VAT."
                required
                error={state.fieldErrors?.['taxLabel']}
              >
                <TextInput
                  id="taxLabel"
                  name="taxLabel"
                  defaultValue={values.taxLabel}
                  maxLength={20}
                  invalid={Boolean(state.fieldErrors?.['taxLabel'])}
                />
              </Field>

              <div className="sm:col-span-2">
                <Toggle
                  name="taxInclusive"
                  label="My prices already include tax"
                  hint="On: the tax is worked out of the price shown. Off: it is added on top."
                  defaultChecked={values.taxInclusive}
                />
              </div>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Stock</h2>

        <div className="space-y-4">
          <Field
            label="Warn me when stock falls to"
            htmlFor="lowStock"
            hint="In whole units. Products at or below this are flagged as low."
            required
            error={state.fieldErrors?.['lowStock']}
          >
            <TextInput
              id="lowStock"
              name="lowStock"
              inputMode="decimal"
              defaultValue={values.lowStock}
              className="tabular max-w-40"
              invalid={Boolean(state.fieldErrors?.['lowStock'])}
            />
          </Field>

          <Toggle
            name="allowOverpayment"
            label="Allow paying more than is owed"
            hint="Off is safer: at a counter an amount larger than the balance is usually a typo, and refusing it catches the mistake while the customer is still standing there. Switch it on to take deposits and advance payments — the extra stays on their account as a credit and comes off their next purchase."
            defaultChecked={values.allowOverpayment}
          />

          <Toggle
            name="allowNegativeStock"
            label="Allow selling stock you do not have"
            hint="Off is safer: a sale that would take stock below zero is refused, which catches mistakes at the till. Turn it on only if you regularly sell goods before recording the delivery."
            defaultChecked={values.allowNegativeStock}
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Financial year</h2>
        <p className="mb-4 text-sm text-content-muted">
          Decides the period covered by the year-end pack you give your accountant. Ghana commonly
          uses January.
        </p>

        <Field
          label="My financial year starts in"
          htmlFor="financialYearStartMonth"
          required
          error={state.fieldErrors?.['financialYearStartMonth']}
        >
          <select
            id="financialYearStartMonth"
            name="financialYearStartMonth"
            defaultValue={String(values.financialYearStartMonth)}
            className="h-11 w-full max-w-56 rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
          >
            {MONTHS.map((month, index) => (
              <option key={month} value={index + 1}>
                {month}
              </option>
            ))}
          </select>
        </Field>

        <p className="mt-3 text-xs text-content-subtle">
          Changing this does not alter a single transaction, but it does change which year each one
          is reported in — a pack you have already given your accountant would no longer come out
          the same. Set it once, at the start.
        </p>
      </Card>

      <div className="flex justify-end">
        <SaveButton />
      </div>
    </form>
  );
}
