'use client';

import { useActionState, useId, useState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  createTaxComponentAction,
  setTaxComponentActiveAction,
  updateTaxComponentAction,
} from '@/actions/tax.actions';
import type { FormState } from '@/actions/auth.actions';
import type { TaxBasis } from '@/db/schema';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Card } from '@/components/ui/page';

/**
 * The taxes the shop charges.
 *
 * Held as a list the owner can edit, because Ghana moves these with the
 * national budget and a shop that has to wait for a new version of the
 * software will charge the wrong tax in the meantime.
 *
 * Each row is its OWN form. One big form with a single Save would make every
 * unrelated row part of every change, and a save that half-applied would leave
 * the shop charging something nobody chose.
 */

export interface TaxComponentRowValues {
  id: number;
  code: string;
  name: string;
  /** Percentage as typed, e.g. "15". Converted to basis points on the server. */
  rate: string;
  basis: TaxBasis;
  isRecoverable: boolean;
  glAccountId: number;
  sortOrder: number;
  isActive: boolean;
  /** How many documents have already charged it. Never edited, only warned about. */
  usage: number;
}

export interface HoldingAccount {
  id: number;
  code: string;
  name: string;
}

const BASIS_LABEL: Record<TaxBasis, string> = {
  NET: 'the goods value',
  NET_PLUS_LEVIES: 'the value plus the taxes above it',
};

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function Check({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        className="mt-1 h-4 w-4 shrink-0 rounded border-line-strong accent-[var(--accent)]"
      />
      <label htmlFor={id} className="text-sm">
        <span className="font-medium text-content">{label}</span>
        <span className="mt-0.5 block text-content-muted">{hint}</span>
      </label>
    </div>
  );
}

/** The fields shared by adding a tax and editing one. */
function TaxFields({
  values,
  accounts,
  state,
}: {
  values?: TaxComponentRowValues;
  accounts: HoldingAccount[];
  state: FormState;
}) {
  const codeId = useId();
  const nameId = useId();
  const rateId = useId();
  const basisId = useId();
  const accountId = useId();
  const orderId = useId();

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" htmlFor={nameId} hint="Appears on the receipt." required>
        <TextInput id={nameId} name="name" defaultValue={values?.name} maxLength={60} required />
      </Field>

      <Field
        label="Code"
        htmlFor={codeId}
        hint="Short, for returns and reports. VAT, NHIL."
        required
        error={state.fieldErrors?.['code']}
      >
        <TextInput
          id={codeId}
          name="code"
          defaultValue={values?.code}
          maxLength={20}
          className="uppercase"
          required
        />
      </Field>

      <Field
        label="Rate"
        htmlFor={rateId}
        hint="A percentage, like 15 or 2.5."
        required
        error={state.fieldErrors?.['rate']}
      >
        <TextInput
          id={rateId}
          name="rate"
          inputMode="decimal"
          defaultValue={values?.rate}
          className="tabular"
          invalid={Boolean(state.fieldErrors?.['rate'])}
          required
        />
      </Field>

      <Field
        label="Charged on"
        htmlFor={basisId}
        hint="Ghana's GRA charges VAT on the value plus the levies."
        error={state.fieldErrors?.['basis']}
      >
        <select
          id={basisId}
          name="basis"
          defaultValue={values?.basis ?? 'NET'}
          className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-content"
        >
          <option value="NET">{BASIS_LABEL.NET}</option>
          <option value="NET_PLUS_LEVIES">{BASIS_LABEL.NET_PLUS_LEVIES}</option>
        </select>
      </Field>

      <Field
        label="Held in"
        htmlFor={accountId}
        hint="Where it waits until it is remitted. Must be a liability."
        required
        error={state.fieldErrors?.['glAccountId']}
      >
        <select
          id={accountId}
          name="glAccountId"
          defaultValue={values?.glAccountId}
          className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-content"
          required
        >
          <option value="">Choose an account…</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Order" htmlFor={orderId} hint="Where it sits on the receipt. Lower is higher.">
        <TextInput
          id={orderId}
          name="sortOrder"
          inputMode="numeric"
          defaultValue={String(values?.sortOrder ?? 50)}
          className="tabular"
        />
      </Field>

      <div className="sm:col-span-2">
        <Check
          name="isRecoverable"
          label="Reclaimable on purchases"
          hint="On for VAT. Off for the levies, which are part of what the goods cost."
          defaultChecked={values?.isRecoverable ?? false}
        />
      </div>
    </div>
  );
}

function EditRow({ values, accounts }: { values: TaxComponentRowValues; accounts: HoldingAccount[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<FormState, FormData>(updateTaxComponentAction, {});
  const [toggleState, toggleAction] = useActionState<FormState, FormData>(
    setTaxComponentActiveAction,
    {},
  );

  return (
    <div className="border-b border-line py-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-content">{values.name}</span>
            <span className="tabular text-sm text-content-muted">{values.rate}%</span>
            {!values.isActive && <Badge tone="neutral">Off</Badge>}
            {values.isRecoverable && <Badge tone="accent">Reclaimable</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-content-muted">
            {values.code} · charged on {BASIS_LABEL[values.basis]}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/*
            A separate form from the editor: switching a tax off is one click
            and must not require filling the rest of the row in correctly.
          */}
          <form action={toggleAction}>
            <input type="hidden" name="id" value={values.id} />
            <input type="hidden" name="isActive" value={values.isActive ? 'off' : 'on'} />
            <Button type="submit" variant="secondary" size="sm">
              {values.isActive ? 'Switch off' : 'Switch on'}
            </Button>
          </form>

          <Button variant="secondary" size="sm" onClick={() => setOpen((was) => !was)}>
            {open ? 'Close' : 'Edit'}
          </Button>
        </div>
      </div>

      {toggleState.error && (
        <div className="mt-3">
          <Alert tone="danger">{toggleState.error}</Alert>
        </div>
      )}

      {open && (
        <form action={formAction} className="mt-4 space-y-4" noValidate>
          <input type="hidden" name="id" value={values.id} />
          <input type="hidden" name="isActive" value={values.isActive ? 'on' : 'off'} />

          {state.error && <Alert tone="danger">{state.error}</Alert>}
          {state.success && <Alert tone="success">{state.success}</Alert>}

          <TaxFields values={values} accounts={accounts} state={state} />

          <p className="text-sm text-content-muted">
            {values.usage > 0
              ? `Charged on ${values.usage} document${values.usage === 1 ? '' : 's'}. Changing it affects sales from now on — those keep what they charged.`
              : 'Not charged on anything yet.'}
          </p>

          <Submit label="Save this tax" pendingLabel="Saving…" />
        </form>
      )}
    </div>
  );
}

function AddForm({ accounts }: { accounts: HoldingAccount[] }) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState<FormState, FormData>(createTaxComponentAction, {});

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Add a tax
      </Button>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.success && <Alert tone="success">{state.success}</Alert>}

      <TaxFields accounts={accounts} state={state} />

      <div className="flex gap-2">
        <Submit label="Add this tax" pendingLabel="Adding…" />
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function TaxComponents({
  rows,
  accounts,
  allIn,
}: {
  rows: TaxComponentRowValues[];
  accounts: HoldingAccount[];
  /** The combined rate, e.g. "20". Worked out from the rows, not added up here. */
  allIn: string;
}) {
  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold text-content">What you charge</h2>
      <p className="mb-4 text-sm text-content-muted">
        Ghana charges NHIL, the GETFund levy and VAT on the same sale, and a VAT invoice has to show
        each one. Rates change with the national budget, so they are set here rather than built into
        the software. A change applies to sales from now on; sales already in the books keep the tax
        they were recorded with.
      </p>

      {rows.length === 0 ? (
        <p className="mb-4 text-sm text-content-muted">No taxes set up.</p>
      ) : (
        <div className="mb-4">
          {rows.map((row) => (
            <EditRow key={row.id} values={row} accounts={accounts} />
          ))}
          <p className="pt-4 text-sm text-content-muted">
            All together, a customer pays <span className="font-medium text-content">{allIn}%</span>{' '}
            on top of the goods value.
          </p>
        </div>
      )}

      <AddForm accounts={accounts} />
    </Card>
  );
}
