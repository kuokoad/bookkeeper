'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { closeYearAction, reopenYearAction } from '@/actions/year-end-close.actions';
import type { FormState } from '@/actions/auth.actions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';

export interface YearOption {
  startYear: number;
  label: string;
  end: string;
  closed: boolean;
  /** False while the year is still running: closing it would be premature. */
  finished: boolean;
}

function SubmitButton({ label, variant }: { label: string; variant?: 'secondary' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} {...(variant ? { variant } : {})}>
      {pending ? 'Working…' : label}
    </Button>
  );
}

/**
 * Closing the year.
 *
 * Closing is a real accounting act — it moves the year's profit into Retained
 * Earnings and locks the period — so the consequences are stated before the
 * button, not after it. Reopening is offered in the same place, because a
 * control that cannot be undone is one people are afraid to use.
 */
export function YearEndForm({ years }: { years: YearOption[] }) {
  const [closeState, closeAction] = useActionState<FormState, FormData>(closeYearAction, {});
  const [reopenState, reopenAction] = useActionState<FormState, FormData>(reopenYearAction, {});

  const closable = years.filter((year) => !year.closed && year.finished);
  const closed = years.filter((year) => year.closed);

  const [chosen, setChosen] = useState(() => closable[0]?.startYear ?? 0);

  return (
    <Card>
      <h2 className="text-sm font-semibold text-content">Year-end close</h2>
      <p className="mt-2 text-sm text-content-muted">
        Closing a year sweeps its sales and costs back to zero and carries the profit into
        Retained Earnings, so the next year starts fresh. Your drawings for the year are cleared
        the same way.
      </p>
      <p className="mt-2 text-sm text-content-muted">
        Nothing already recorded is altered — the close is one dated journal entry you can inspect,
        and reversing it reopens the year.
      </p>

      {closeState.error && (
        <Alert tone="danger" className="mt-4">
          {closeState.error}
        </Alert>
      )}
      {closeState.success && (
        <Alert tone="success" className="mt-4">
          {closeState.success}
        </Alert>
      )}
      {reopenState.error && (
        <Alert tone="danger" className="mt-4">
          {reopenState.error}
        </Alert>
      )}
      {reopenState.success && (
        <Alert tone="success" className="mt-4">
          {reopenState.success}
        </Alert>
      )}

      {closable.length === 0 ? (
        <Alert tone="info" className="mt-4">
          There is no finished year waiting to be closed. A year can only be closed once it has
          ended.
        </Alert>
      ) : (
        <form action={closeAction} className="mt-4 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="startYear" className="mb-1 block text-xs text-content-muted">
              Year to close
            </label>
            <select
              id="startYear"
              name="startYear"
              value={String(chosen)}
              onChange={(event) => setChosen(Number(event.target.value))}
              className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
            >
              {closable.map((year) => (
                <option key={year.startYear} value={year.startYear}>
                  {year.label} (ends {year.end})
                </option>
              ))}
            </select>
          </div>
          <SubmitButton label="Close this year" />
        </form>
      )}

      {closed.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">
            Closed years
          </p>
          <ul className="space-y-2">
            {closed.map((year) => (
              <li key={year.startYear} className="flex flex-wrap items-center gap-3">
                <Badge tone="success">{year.label}</Badge>
                <span className="text-sm text-content-muted">closed to {year.end}</span>
                <form action={reopenAction} className="ml-auto">
                  <input type="hidden" name="startYear" value={year.startYear} />
                  <SubmitButton label="Reopen" variant="secondary" />
                </form>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-content-subtle">
            Reopening reverses the closing entry rather than deleting it, and is recorded in the
            audit log. Years reopen newest first.
          </p>
        </div>
      )}
    </Card>
  );
}
