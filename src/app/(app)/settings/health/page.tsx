import type { Metadata } from 'next';
import Link from 'next/link';

import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { runPreflight } from '@/db/preflight';
import { db } from '@/db/client';
import { describeBackupStatus, getBackupStatus } from '@/services/backup.service';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader, Stat } from '@/components/ui/page';

export const metadata: Metadata = { title: 'Health & backup' };
export const dynamic = 'force-dynamic';

const TONES = { pass: 'success', warn: 'warning', fail: 'danger' } as const;
const LABELS = { pass: 'OK', warn: 'Check', fail: 'Problem' } as const;

/**
 * The readiness checks and the backup button.
 *
 * Both exist as command-line tools, which is no use on a host with no
 * terminal — and no use to a shop owner in any case. This is the same
 * `runPreflight` the command runs, rendered.
 */
export default async function HealthPage() {
  const user = await requirePageAccess('settings', 'view');
  // Taking a backup needs the same permission the download route enforces.
  // Showing the button to someone the server would refuse is a button that
  // does nothing.
  const canBackUp = can(user, 'settings', 'edit');

  // The dashboard sends people here when a backup is overdue, so this is the
  // page that has to answer "am I up to date?" — a download button on its own
  // cannot.
  const backup = getBackupStatus(db);
  const checks = runPreflight();

  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Health &amp; backup"
        description="Whether this shop is safe to trade on, and how to take a copy of your records."
        actions={
          <Link href="/settings">
            <Button variant="secondary" size="sm">
              Settings
            </Button>
          </Link>
        }
      />

      <Card className="mb-6">
        <h2 className="text-sm font-semibold text-content">Back up your records</h2>
        <p className="mt-2 text-sm text-content-muted">
          Everything your shop has ever recorded is in one file. This makes a fresh copy, checks it
          opens and that the books inside it balance, then sends it to your computer.
        </p>
        <p className="mt-2 text-sm text-content-muted">
          Do this at the end of each day, and keep the file somewhere other than this computer — a
          copy that lives beside the original does not survive the original being lost.
        </p>

        {/*
          Uses `Alert` rather than a hand-rolled bordered box. The app's semantic
          colour reaches the eye through the BACKGROUND — `border-warning` and
          friends resolve to the same neutral as every other border — so a panel
          that carried its state in a border alone looked identical whether the
          shop was up to date or a month behind.
        */}
        <div className="mt-4">
          <Alert
            tone={
              backup.state === 'current' ? 'info' : backup.state === 'due' ? 'warning' : 'danger'
            }
            title={backup.state === 'current' ? 'Up to date' : 'Backup needed'}
          >
            {describeBackupStatus(backup)}
            {backup.lastTakenAt && (
              <span className="mt-1 block text-xs text-content-subtle">
                Last taken {formatDateTime(backup.lastTakenAt)}.
              </span>
            )}
          </Alert>
        </div>

        {/* A plain link, not a form: the browser downloads the response. */}
        {canBackUp ? (
          <div className="mt-4">
            <a href="/api/backup" download>
              <Button>Download a backup</Button>
            </a>
          </div>
        ) : (
          <p className="mt-4 text-sm text-content-subtle">
            Only the shop owner can take a backup — it contains every customer and every figure.
          </p>
        )}
      </Card>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat icon="check" label="Checks passed" value={String(checks.length - failures.length - warnings.length)} />
        <Stat
          icon="warning"
          label="Problems"
          value={String(failures.length)}
          {...(failures.length > 0 ? { tone: 'danger' as const } : {})}
        />
        <Stat
          icon="warning"
          label="Worth checking"
          value={String(warnings.length)}
          {...(warnings.length > 0 ? { tone: 'warning' as const } : {})}
        />
      </div>

      {failures.length > 0 && (
        <Alert tone="danger" title="Do not trade on this yet" className="mb-4">
          {failures.length} thing(s) below must be put right first. Each one is something that
          would misstate your money or let the wrong person in.
        </Alert>
      )}
      {failures.length === 0 && warnings.length === 0 && (
        <Alert tone="success" className="mb-4">
          Everything checks out. Your books balance and nothing is misconfigured.
        </Alert>
      )}

      <div className="space-y-2">
        {checks.map((check) => (
          <div
            key={check.name}
            className="flex items-start justify-between gap-4 rounded-lg border border-line bg-surface-raised px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-content">{check.name}</p>
              <p className="mt-0.5 break-words text-sm text-content-muted">{check.detail}</p>
            </div>
            <Badge tone={TONES[check.status]}>{LABELS[check.status]}</Badge>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-content-subtle">
        These are the same checks as <code>npm run preflight</code>, and the backup is the same as{' '}
        <code>npm run backup</code> — shown here because a shop counter has no command line.
      </p>
    </div>
  );
}
