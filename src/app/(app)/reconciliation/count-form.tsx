'use client';

import { useState } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { reconcileAction, type ReconcileFormState } from '@/actions/reconciliation.actions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AmountInput, Field, TextInput } from '@/components/ui/field';

export interface CountableAccount {
  id: number;
  name: string;
  kind: string;
  /** Book balance right now, in minor units. */
  balanceMinor: number;
}

function fmt(minorValue: number): string {
  const digits = Math.abs(Math.round(minorValue)).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minorValue < 0 ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

function toMinor(text: string): number {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return Number.NaN;
  if (!/^\d*\.?\d{0,2}$/.test(trimmed)) return Number.NaN;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0') || '0');
}

function SubmitButton({ hasDifference }: { hasDifference: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? 'Saving…' : hasDifference ? 'Save count and difference' : 'Save count'}
    </Button>
  );
}

/**
 * Counting an account.
 *
 * The difference is shown live as the owner types, BEFORE they commit, so they
 * get the chance to recount rather than being told after the fact. The books
 * are never edited to match — accepting the difference posts a visible
 * adjusting entry instead.
 */
export function CountForm({
  accounts,
  today,
  currencyCode,
  expectedByAccount,
}: {
  accounts: CountableAccount[];
  today: string;
  currencyCode: string;
  expectedByAccount: Record<number, number>;
}) {
  const [state, formAction] = useActionState<ReconcileFormState, FormData>(reconcileAction, {});
  const [accountId, setAccountId] = useState(String(accounts[0]?.id ?? ''));
  const [actual, setActual] = useState('');
  const [adjust, setAdjust] = useState(true);

  const expected = expectedByAccount[Number(accountId)] ?? 0;
  const counted = toMinor(actual);
  const hasCount = actual.trim() !== '' && !Number.isNaN(counted);
  const difference = hasCount ? counted - expected : 0;
  const needsExplanation = hasCount && difference !== 0;

  // A saved result replaces the form's own live figures.
  const saved = state.reconciliationNo !== undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {saved && (
        <Alert
          tone={state.differenceMinor === 0 ? 'success' : 'warning'}
          title={`Count saved — ${state.reconciliationNo}`}
        >
          {state.differenceMinor === 0 ? (
            <p>The books and the count agreed exactly.</p>
          ) : (
            <p>
              Difference of {currencyCode} {fmt(state.differenceMinor ?? 0)}{' '}
              {state.adjusted
                ? 'was posted to Cash Over / Short, so the books now match what you counted.'
                : 'was recorded and left open. The books are unchanged until you resolve it.'}
            </p>
          )}
        </Alert>
      )}

      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account to count" htmlFor="paymentAccountId" required>
            <select
              id="paymentAccountId"
              name="paymentAccountId"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              {accounts.map((account) => (
                <option key={account.id} value={String(account.id)}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Date being counted"
            htmlFor="businessDate"
            required
            hint="The balance is compared as at this day."
            error={state.fieldErrors?.['businessDate']}
          >
            <TextInput
              id="businessDate"
              name="businessDate"
              type="date"
              defaultValue={today}
              required
            />
          </Field>
        </div>

        <dl className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-content-muted">The books say</dt>
            <dd className="tabular font-medium text-content">
              {currencyCode} {fmt(expected)}
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <Field
            label={`What did you actually count? (${currencyCode})`}
            htmlFor="actual"
            required
            error={state.fieldErrors?.['actual']}
          >
            <AmountInput
              id="actual"
              name="actual"
              value={actual}
              onChange={(event) => setActual(event.target.value)}
              placeholder="0.00"
              required
              autoFocus
              className="h-12 text-lg"
              invalid={Boolean(state.fieldErrors?.['actual']) || (actual !== '' && Number.isNaN(counted))}
            />
          </Field>
        </div>

        {hasCount && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 ${
              difference === 0
                ? 'border-success/40 bg-success-soft'
                : 'border-warning/40 bg-warning-soft'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-content">
                {difference === 0
                  ? 'Agrees exactly'
                  : difference > 0
                    ? 'More than the books say'
                    : 'Less than the books say'}
              </span>
              <span className="tabular text-lg font-semibold text-content">
                {difference === 0 ? '—' : `${currencyCode} ${fmt(difference)}`}
              </span>
            </div>
            {difference !== 0 && (
              <p className="mt-1 text-xs text-content-muted">
                Worth recounting before you save. If the difference is real, explain it below.
              </p>
            )}
          </div>
        )}
      </div>

      {needsExplanation && (
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <Field
            label="What do you think happened?"
            htmlFor="explanation"
            required
            hint="Required whenever there is a difference. This is kept permanently."
            error={state.fieldErrors?.['explanation']}
          >
            <TextInput
              id="explanation"
              name="explanation"
              placeholder="e.g. Gave wrong change during the rush"
              required
            />
          </Field>

          <div className="mt-4 flex items-start gap-3">
            <input
              id="adjust"
              name="adjust"
              type="checkbox"
              checked={adjust}
              onChange={(event) => setAdjust(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-line-strong"
            />
            <label htmlFor="adjust" className="text-sm text-content">
              Correct the books to match what I counted
              <span className="mt-0.5 block text-xs text-content-subtle">
                {adjust
                  ? 'The difference will be posted to Cash Over / Short, so it shows up in your profit figure. Nothing already recorded is changed.'
                  : 'The books will be left alone and the difference recorded as unresolved, so you can look for the money first.'}
              </span>
            </label>
          </div>
        </div>
      )}

      <SubmitButton hasDifference={needsExplanation} />

      <p className="text-xs text-content-subtle">
        No past transaction is ever edited to make the numbers agree. A difference you accept is
        posted as its own entry, so the shortage or surplus stays visible in the accounts.
      </p>
    </form>
  );
}
