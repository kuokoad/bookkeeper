'use server';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { isDomainError } from '@/domain/errors';
import { writeAudit } from '@/services/audit.service';
import { assertActorIsOwner } from '@/services/role-guard';
import {
  checkForUpdates,
  readUpdateStatus,
  startUpdate,
  updateUnsupportedReason,
  UPDATE_DATA_DIR,
  UPDATE_STATUS_PATH,
  type UpdateCheck,
} from '@/services/update.service';
import type { FormState } from './auth.actions';

/**
 * Checking for and installing a new version of the app.
 *
 * Owner only, not merely `settings` edit: installing replaces the program that
 * keeps the books, and stops every till while it does.
 */

export interface UpdateCheckState {
  error?: string;
  result?: UpdateCheck;
}

async function requireOwner(what: string) {
  const actor = await requirePermission('settings', 'edit');
  assertActorIsOwner(db, actor, what);
  return actor;
}

export async function checkForUpdatesAction(): Promise<UpdateCheckState> {
  try {
    await requireOwner('check for updates');
  } catch (error) {
    if (isDomainError(error)) return { error: 'Only the shop owner can update the app.' };
    throw error;
  }
  const unsupported = updateUnsupportedReason();
  if (unsupported) return { error: unsupported };

  return { result: await checkForUpdates(process.cwd()) };
}

export async function startUpdateAction(): Promise<FormState> {
  let actor;
  try {
    actor = await requireOwner('update the app');
  } catch (error) {
    if (isDomainError(error)) return { error: 'Only the shop owner can update the app.' };
    throw error;
  }
  const unsupported = updateUnsupportedReason();
  if (unsupported) return { error: unsupported };

  if (readUpdateStatus(UPDATE_STATUS_PATH)?.state === 'running') {
    return { error: 'An update is already running.' };
  }

  // `next start -p` puts the port here; the updater stops whatever listens on it.
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0) {
    return { error: 'Could not tell which port the app is running on, so it cannot be restarted safely.' };
  }

  writeAudit(db, {
    action: 'UPDATE',
    entityType: 'app',
    userId: actor.id,
    username: actor.username,
    summary: 'Started an update of the app',
  });
  startUpdate({ cwd: process.cwd(), port, dataDir: UPDATE_DATA_DIR });

  return { success: 'Updating. The app will be unavailable for a few minutes.' };
}
