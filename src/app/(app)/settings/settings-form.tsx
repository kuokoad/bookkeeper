'use client';

import { useActionState, useId, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { updateSettingsAction } from '@/actions/settings.actions';
import type { FormState } from '@/actions/auth.actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Card } from '@/components/ui/page';
import { LOOKS, LOOK_LABELS, type Look } from '@/lib/look';

export interface SettingsFormValues {
  businessName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  currencyCode: string;
  currencySymbol: string;
  look: Look;
  taxEnabled: boolean;
  taxInclusive: boolean;
  /** What the shop currently charges, all in, e.g. "20". Shown, never edited here. */
  taxSummary: string;
  /** Whole units as typed, e.g. "5" or "2.5". */
  lowStock: string;
  allowNegativeStock: boolean;
  expiryWarningDays: string;
  expiryBlocksSales: boolean;
  allowOverpayment: boolean;
  defaultTermsDays: number;
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
            <Field
              label="Tagline"
              htmlFor="tagline"
              hint="The small line under your shop name in the menu. Leave it empty to show nothing."
              error={state.fieldErrors?.['tagline']}
            >
              <TextInput
                id="tagline"
                name="tagline"
                defaultValue={values.tagline}
                maxLength={60}
                placeholder="Bookkeeping & stock"
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
        <h2 className="mb-1 text-sm font-semibold text-content">Look</h2>
        <p className="mb-4 text-sm text-content-muted">
          How every screen in the shop is painted. This changes nothing about your figures, and
          applies to whichever screen anyone signs in on.
        </p>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Look</legend>
          {LOOKS.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer gap-3 rounded-xl border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
            >
              <input
                type="radio"
                name="look"
                value={option}
                defaultChecked={values.look === option}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-content">
                  {LOOK_LABELS[option].name}
                </span>
                <span className="mt-0.5 block text-xs text-content-muted">
                  {LOOK_LABELS[option].blurb}
                </span>
                {/* A swatch, so the difference is visible before saving rather
                    than only after. Hard-coded rather than token-driven: it has
                    to show the look you are NOT currently wearing. */}
                <span className="mt-2 flex gap-1" aria-hidden="true">
                  {(option === 'ledger'
                    ? ['#e8dcc8', '#fdfaf3', '#453729', '#7c9a6d']
                    : ['#f7f8fa', '#ffffff', '#2b3038', '#2f9e77']
                  ).map((swatch) => (
                    <span
                      key={swatch}
                      className="h-4 w-6 rounded border border-line"
                      style={{ backgroundColor: swatch }}
                    />
                  ))}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
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
            saving with tax switched off would quietly reset "prices include
            tax". Kept in the DOM, the stored value rides along untouched.
          */}
          <div hidden={!taxEnabled} className="space-y-4 border-l-2 border-line pl-4">
            <Toggle
              name="taxInclusive"
              label="My prices already include tax"
              hint="On: the tax is worked out of the price shown. Off: it is added on top."
              defaultChecked={values.taxInclusive}
            />

            <p className="text-sm text-content-muted">
              Currently charging <span className="font-medium text-content">{values.taxSummary}</span>.
              The individual taxes and their rates are set below.
            </p>
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
        <h2 className="mb-4 text-sm font-semibold text-content">Expiry dates</h2>
        <p className="mb-4 text-sm text-content-muted">
          Only applies to stock you have given a date to. A shop that never enters one never sees
          any of this.
        </p>

        <div className="space-y-4">
          <Field
            label="Tell me this many days before stock goes off"
            htmlFor="expiryWarningDays"
            hint="Thirty days suits tinned goods. A shop selling bread and milk wants far less — a warning that arrives a month early about something that lasts a week is noise."
            required
            error={state.fieldErrors?.['expiryWarningDays']}
          >
            <TextInput
              id="expiryWarningDays"
              name="expiryWarningDays"
              inputMode="numeric"
              defaultValue={values.expiryWarningDays}
              className="tabular max-w-40"
              invalid={Boolean(state.fieldErrors?.['expiryWarningDays'])}
            />
          </Field>

          <Toggle
            name="expiryBlocksSales"
            label="Stop the till selling stock that has passed its date"
            hint="On is safer, and it only fires when there is nothing else left — expired stock is passed over in silence while there is good stock to sell, so nobody is interrupted for a crate at the back of the shelf. Someone who can write stock off may approve the sale anyway, and that approval is recorded. Turn it off and dates become information only."
            defaultChecked={values.expiryBlocksSales}
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold text-content">Credit and invoices</h2>
        <p className="mb-4 text-sm text-content-muted">
          When a customer takes goods without paying in full, the sale becomes an invoice with a
          number and a date it falls due. This is how long they get to pay.
        </p>

        <Field
          label="Payment terms"
          htmlFor="defaultTermsDays"
          hint="Days from the sale. Zero means due immediately."
          required
          error={state.fieldErrors?.['defaultTermsDays']}
        >
          <TextInput
            id="defaultTermsDays"
            name="defaultTermsDays"
            inputMode="numeric"
            defaultValue={String(values.defaultTermsDays)}
            className="tabular max-w-32"
            invalid={Boolean(state.fieldErrors?.['defaultTermsDays'])}
          />
        </Field>

        <p className="mt-3 text-xs text-content-subtle">
          Changing this affects invoices issued from now on. Ones already in a customer&apos;s hands
          keep the terms they were issued with.
        </p>
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
