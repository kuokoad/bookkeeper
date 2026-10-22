'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { productImportAction } from '@/actions/catalog.actions';
import { IMPORT_FIELDS, type ProductImportState } from '@/lib/product-import-fields';
import { toDecimalString } from '@/domain/money';
import { formatQty } from '@/domain/quantity';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

function SubmitButton({
  intent,
  label,
  busy,
  variant,
  disabled,
}: {
  intent: string;
  label: string;
  busy: string;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name="intent" value={intent} variant={variant} disabled={pending || disabled}>
      {pending ? busy : label}
    </Button>
  );
}

function columnName(index: number, heading: string): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return heading.trim() ? `${letters} — ${heading.trim()}` : `${letters} (no heading)`;
}

const money = (value: number | null) => (value === null ? '' : toDecimalString(value as never));

export function ImportForm() {
  const [state, formAction] = useActionState<ProductImportState, FormData>(productImportAction, {});
  const header = state.cells?.[0] ?? [];
  const columns = Math.max(0, ...(state.cells ?? []).map((row) => row.length));
  const preview = state.preview;

  return (
    <div className="space-y-6">
      {state.error && <Alert tone="danger">{state.error}</Alert>}

      <form action={formAction} className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <Field
              label="Price list"
              htmlFor="file"
              hint="The first sheet is read. Headings go in row 1, one product per row below. Up to 2 MB."
            >
              <input
                id="file"
                name="file"
                type="file"
                accept=".xlsx,.csv"
                required
                className="block w-full text-sm text-content file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-surface-sunken file:px-3 file:py-2 file:text-content"
              />
            </Field>
          </div>
          <SubmitButton intent="upload" label="Read file" busy="Reading…" variant="secondary" />
        </div>
      </form>

      {state.cells && (
        <form
          // Remount on every server answer so the controls show what the server
          // resolved, not what was last typed.
          key={JSON.stringify([state.fileName, state.map, state.packUnit])}
          action={formAction}
          className="space-y-6"
        >
          <input type="hidden" name="cells" value={JSON.stringify(state.cells)} />
          <input type="hidden" name="fileName" value={state.fileName ?? ''} />
          {/* What the preview below was built from; the server refuses an import that differs. */}
          {preview &&
            IMPORT_FIELDS.map(({ key }) => (
              <input
                key={key}
                type="hidden"
                name={`previewed_${key}`}
                value={state.map?.[key] === undefined ? '' : String(state.map[key])}
              />
            ))}
          {preview && <input type="hidden" name="previewedPackUnit" value={state.packUnit ?? ''} />}

          <section className="rounded-xl border border-line bg-surface-raised p-4">
            <h2 className="mb-1 font-semibold text-content">Columns in {state.fileName}</h2>
            <p className="mb-4 text-sm text-content-muted">
              Check each field is read from the right column. Stock quantities are not imported —
              record opening stock as a stock adjustment afterwards.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {IMPORT_FIELDS.map(({ key, label }) => (
                <Field key={key} label={label} htmlFor={`column_${key}`} required={key === 'name'}>
                  <Select
                    id={`column_${key}`}
                    name={`column_${key}`}
                    defaultValue={state.map?.[key] === undefined ? '' : String(state.map[key])}
                    className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
                  >
                    <option value="">Not imported</option>
                    {Array.from({ length: columns }, (_, i) => (
                      <option key={i} value={String(i)}>
                        {columnName(i, header[i] ?? '')}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
              <Field
                label="Pack unit"
                htmlFor="packUnit"
                hint="What a pack is called, e.g. pack, carton, box. Used with units per pack."
              >
                <TextInput id="packUnit" name="packUnit" defaultValue={state.packUnit ?? ''} maxLength={20} />
              </Field>
            </div>
            <div className="mt-4">
              <SubmitButton intent="preview" label="Update preview" busy="Checking…" variant="secondary" />
            </div>
          </section>

          {preview && (
            <>
              {preview.warnings.map((warning) => (
                <Alert key={warning} tone="warning">
                  {warning}
                </Alert>
              ))}
              {preview.newUnits.length > 0 && (
                <Alert tone="info">
                  These units are not on your Units list and will be added: {preview.newUnits.join(', ')}.
                </Alert>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-content">
                  <strong>{preview.ready}</strong> ready to import
                  {preview.skipped > 0 && (
                    <>
                      , <strong>{preview.skipped}</strong> will be skipped
                    </>
                  )}
                  .
                </p>
                <div className="flex gap-2">
                  <Link href="/products">
                    <Button type="button" variant="secondary">
                      Cancel
                    </Button>
                  </Link>
                  <SubmitButton
                    intent="import"
                    label={`Import ${preview.ready} product${preview.ready === 1 ? '' : 's'}`}
                    busy="Importing…"
                    disabled={preview.ready === 0}
                  />
                </div>
              </div>

              <TableWrap>
                <THead>
                  <TH>Row</TH>
                  <TH>Status</TH>
                  <TH>Product</TH>
                  <TH>Code</TH>
                  <TH>Unit</TH>
                  <TH numeric>Cost</TH>
                  <TH numeric>Price</TH>
                  <TH>Pack</TH>
                  <TH numeric>Pack cost</TH>
                  <TH numeric>Pack price</TH>
                  <TH>Notes</TH>
                </THead>
                <tbody>
                  {preview.rows.map((row) => (
                    <TR key={row.line} className={row.problems.length > 0 ? 'bg-danger-soft' : undefined}>
                      <TD className="text-content-subtle">{row.line}</TD>
                      <TD>
                        {row.problems.length > 0 ? (
                          <Badge tone="danger">Skipped</Badge>
                        ) : (
                          <Badge tone="success">Ready</Badge>
                        )}
                      </TD>
                      <TD className="font-medium">{row.name}</TD>
                      <TD>{row.sku}</TD>
                      <TD>{row.unit}</TD>
                      <TD numeric>{money(row.costPrice)}</TD>
                      <TD numeric>{money(row.sellingPrice)}</TD>
                      <TD>
                        {row.altUnit && row.altFactor !== null
                          ? `1 ${row.altUnit} = ${formatQty(row.altFactor)} ${row.unit}`
                          : ''}
                      </TD>
                      <TD numeric>{money(row.altCostPrice)}</TD>
                      <TD numeric>{money(row.altSellingPrice)}</TD>
                      <TD className="max-w-md whitespace-normal text-xs">
                        {row.problems.map((problem) => (
                          <p key={problem} className="font-medium text-danger">
                            {problem}
                          </p>
                        ))}
                        {row.notes.map((note) => (
                          <p key={note} className="text-content-muted">
                            {note}
                          </p>
                        ))}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </TableWrap>
            </>
          )}
        </form>
      )}
    </div>
  );
}
