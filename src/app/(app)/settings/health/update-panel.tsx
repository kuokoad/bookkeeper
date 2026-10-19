'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { checkForUpdatesAction, startUpdateAction, type UpdateCheckState } from '@/actions/update.actions';
import type { FormState } from '@/actions/auth.actions';
import type { InstalledVersion, UpdateStatus } from '@/services/update.service';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/page';

const POLL_MS = 5_000;

function SubmitButton({ idle, busy, variant }: { idle: string; busy: string; variant?: 'primary' | 'secondary' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant ?? 'primary'} disabled={pending}>
      {pending ? busy : idle}
    </Button>
  );
}

/**
 * Waits out the restart. The server goes away mid-update, so failed requests
 * are expected and simply retried; the page reloads once the updater has
 * written its outcome, which the reloaded page then shows.
 */
function useReloadWhenUpdateFinishes(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch('/api/update', { cache: 'no-store' });
        if (!response.ok) return;
        const status = (await response.json()) as UpdateStatus | null;
        if (status && status.state !== 'running') window.location.reload();
      } catch {
        // The app is down while it updates. Keep asking.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * Installing a new version from the Health screen, so a shop with no one who
 * uses a terminal still gets fixes. Two steps, like voiding: the update stops
 * every till for a few minutes, so it is never one unguarded click.
 */
export function UpdatePanel({
  version,
  lastStatus,
  isOwner,
  unsupportedReason,
}: {
  version: InstalledVersion | null;
  lastStatus: UpdateStatus | null;
  isOwner: boolean;
  unsupportedReason: string | null;
}) {
  const [check, checkAction] = useActionState<UpdateCheckState>(checkForUpdatesAction, {});
  const [start, startAction] = useActionState<FormState>(startUpdateAction, {});
  const [confirming, setConfirming] = useState(false);

  const updating = Boolean(start.success) || lastStatus?.state === 'running';
  useReloadWhenUpdateFinishes(updating);

  const changes = check.result?.ok ? check.result.changes : [];

  return (
    <Card className="mb-6">
      <h2 className="text-sm font-semibold text-content">Update the app</h2>
      <p className="mt-2 text-sm text-content-muted">
        {version
          ? `This computer is running version ${version.hash}, from ${version.date}.`
          : 'The installed version could not be read.'}
      </p>

      {updating ? (
        <Alert tone="info" title="Updating" className="mt-4">
          A backup is taken first, then the app stops, installs the new version and starts again.
          This usually takes a few minutes. Leave this page open; it reloads when the app is back.
        </Alert>
      ) : (
        lastStatus && (
          <Alert
            tone={lastStatus.state === 'done' ? 'success' : 'danger'}
            title={lastStatus.state === 'done' ? 'Last update installed' : 'Last update failed'}
            className="mt-4"
          >
            {lastStatus.message}
          </Alert>
        )
      )}

      {!updating && !isOwner && (
        <p className="mt-4 text-sm text-content-subtle">Only the shop owner can update the app.</p>
      )}
      {!updating && isOwner && unsupportedReason && (
        <p className="mt-4 text-sm text-content-subtle">{unsupportedReason}</p>
      )}

      {!updating && isOwner && !unsupportedReason && (
        <div className="mt-4 space-y-4">
          {check.error && <Alert tone="danger">{check.error}</Alert>}
          {check.result && !check.result.ok && <Alert tone="warning">{check.result.reason}</Alert>}
          {check.result?.ok && changes.length === 0 && (
            <Alert tone="success">This is the newest version.</Alert>
          )}
          {start.error && <Alert tone="danger">{start.error}</Alert>}

          {changes.length > 0 && (
            <div>
              <p className="text-sm font-medium text-content">
                {changes.length} change{changes.length === 1 ? '' : 's'} available:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-content-muted">
                {changes.map((change) => (
                  <li key={change.hash}>{change.subject}</li>
                ))}
              </ul>
            </div>
          )}

          {changes.length > 0 && confirming ? (
            <Alert tone="warning" title="Stop trading first">
              Every till will be unavailable for a few minutes while the update installs. Finish any
              sale in progress, then continue. A backup is taken before anything changes.
              <form action={startAction} className="mt-3 flex gap-2">
                <SubmitButton idle="Yes, update now" busy="Starting…" />
                <Button type="button" size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                  Not now
                </Button>
              </form>
            </Alert>
          ) : (
            <div className="flex gap-2">
              <form action={checkAction}>
                <SubmitButton
                  idle="Check for updates"
                  busy="Checking…"
                  variant={changes.length > 0 ? 'secondary' : 'primary'}
                />
              </form>
              {changes.length > 0 && (
                <Button type="button" size="sm" onClick={() => setConfirming(true)}>
                  Update now…
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
