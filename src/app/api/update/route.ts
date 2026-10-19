import { requirePermission } from '@/lib/auth/current-user';
import { isDomainError } from '@/domain/errors';
import { readUpdateStatus, UPDATE_STATUS_PATH } from '@/services/update.service';

export const dynamic = 'force-dynamic';

/**
 * Where an update has got to, for the Health page to poll while the app goes
 * down and comes back. A route rather than a server action: action ids change
 * with every build, so the page that started the update could not call the new
 * version's action to ask whether it had arrived.
 */
export async function GET(): Promise<Response> {
  try {
    await requirePermission('settings', 'edit');
  } catch (error) {
    if (isDomainError(error)) return new Response(null, { status: 403 });
    throw error;
  }
  return Response.json(readUpdateStatus(UPDATE_STATUS_PATH), { headers: { 'Cache-Control': 'no-store' } });
}
