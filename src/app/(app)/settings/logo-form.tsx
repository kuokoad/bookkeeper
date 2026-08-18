'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { removeLogoAction, uploadLogoAction } from '@/actions/settings.actions';
import type { FormState } from '@/actions/auth.actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Card } from '@/components/ui/page';

export interface LogoState {
  hasLogo: boolean;
  width: number | null;
  height: number | null;
  bytes: number;
  /** Changes whenever the logo does, so the browser fetches the new one. */
  version: number;
}

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Uploading…' : 'Upload logo'}
    </Button>
  );
}

function RemoveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant="secondary" disabled={pending}>
      {pending ? 'Removing…' : 'Remove'}
    </Button>
  );
}

/**
 * The shop's logo, for the top of receipts.
 *
 * The accept attribute is a convenience for the file picker only — the server
 * confirms the format from the file's own bytes, because anything the browser
 * says about a file is chosen by whoever is uploading it.
 */
export function LogoForm({ logo }: { logo: LogoState }) {
  const [state, formAction] = useActionState<FormState, FormData>(uploadLogoAction, {});
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold text-content">Logo</h2>
      <p className="mb-4 text-sm text-content-muted">
        Printed at the top of receipts, beside your shop name.
      </p>

      {state.error && <Alert tone="danger" className="mb-4">{state.error}</Alert>}
      {state.success && <Alert tone="success" className="mb-4">{state.success}</Alert>}

      {logo.hasLogo && (
        <div className="mb-4 flex flex-wrap items-center gap-4">
          {/*
            A plain <img>, not next/image: the source is a route reading a blob
            out of the database, and there is nothing for the optimiser to do
            with it. `version` busts the cache when the logo changes.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/logo?v=${logo.version}`}
            alt="Your shop logo"
            className="max-h-20 max-w-40 rounded border border-line bg-surface-raised object-contain p-2"
          />
          <div className="text-sm text-content-muted">
            <p>
              {logo.width} x {logo.height} pixels
            </p>
            <p>{(logo.bytes / 1024).toFixed(0)} KB, stored in your database</p>
            <form action={removeLogoAction} className="mt-2">
              <RemoveButton />
            </form>
          </div>
        </div>
      )}

      <form action={formAction} className="space-y-3">
        <Field
          label={logo.hasLogo ? 'Replace it' : 'Choose an image'}
          htmlFor="logo"
          hint="PNG, JPEG or WebP, up to 1 MB."
          error={state.fieldErrors?.['logo']}
        >
          <input
            id="logo"
            name="logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => setChosen(event.target.files?.[0]?.name ?? null)}
            className="block w-full text-sm text-content file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-surface-sunken file:px-3 file:py-2 file:text-sm file:text-content hover:file:bg-surface-raised"
          />
        </Field>

        {chosen && <p className="text-xs text-content-subtle">Selected: {chosen}</p>}

        <UploadButton />
      </form>

      <p className="mt-4 text-xs text-content-subtle">
        The image is kept inside your database, so it is included in every backup and survives a
        reinstall. SVG files are not accepted — they can carry instructions that run in the
        browser, which is not a risk worth taking for a logo.
      </p>
    </Card>
  );
}
