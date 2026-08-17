import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { createBackup } from '@/db/backup';
import { writeAudit } from '@/services/audit.service';
import { getSettings } from '@/services/settings.service';
import { isDomainError } from '@/domain/errors';

export const dynamic = 'force-dynamic';

/**
 * Downloads a verified backup of the whole database.
 *
 * On a managed host there is no terminal and no cron, so `npm run backup`
 * cannot be run — and a shop with no way to take a backup has no business
 * holding its own accounts. This is that command, reachable by the owner.
 *
 * It is arguably the better arrangement anyway: the file lands on the owner's
 * own computer rather than beside the database it is meant to protect, which is
 * where a backup needs to be.
 *
 * The backup is verified before it is sent — integrity, foreign keys, and that
 * the books inside the copy still balance. An unverifiable copy is never
 * handed over as if it were a safety net.
 */
export async function GET(): Promise<Response> {
  let actor;
  try {
    // The same owner-level permission as the other controls that affect the
    // whole shop. A backup is a complete copy of every customer and every
    // figure, so it is not something a till operator should be able to take.
    actor = await requirePermission('settings', 'edit');
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNAUTHENTICATED') {
      return new Response('Please sign in.', { status: 401 });
    }
    if (isDomainError(error) && error.code === 'FORBIDDEN') {
      return new Response('You do not have permission to download a backup.', { status: 403 });
    }
    throw error;
  }

  // Written to a throwaway directory and removed once read, so backups are not
  // left accumulating on a host whose disk the shop does not manage.
  const directory = mkdtempSync(join(tmpdir(), 'bookkeeper-download-'));

  try {
    const result = await createBackup({ directory, keep: 1 });
    const body = readFileSync(result.path);

    const shopName = getSettings(db)
      .businessName.replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    const filename = `${shopName || 'shop'}-${basename(result.path)}`;

    writeAudit(db, {
      action: 'CREATE',
      entityType: 'backup',
      userId: actor.id,
      username: actor.username,
      summary: `Downloaded a backup (${result.entries} journal entries, verified)`,
    });

    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(body.byteLength),
        // A backup is a point-in-time copy; a cached one would be a lie.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    // Never answer a failed backup with something that looks like a file.
    const reason = error instanceof Error ? error.message : String(error);
    console.error('Backup download failed:', reason);
    return new Response(`The backup could not be made: ${reason}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
