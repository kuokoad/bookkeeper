import { eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import { userPermissions, users } from '@/db/schema';
import { PERMISSION_MODULES } from '@/db/schema/users';
import type { PermissionMap } from '@/lib/auth/permissions';
import { ForbiddenError } from '@/domain/errors';

/**
 * Who is allowed to hand out rights.
 *
 * The `users` module lets an owner delegate looking after staff accounts —
 * resetting a forgotten password, unlocking someone who mistyped it five times,
 * switching a leaver off. Those are chores, and a trusted senior person can be
 * given them.
 *
 * Deciding what somebody may *do* is not a chore. Left ungated, a staff member
 * holding `users:edit` could set their own role to OWNER, or tick every box for
 * a colleague and then sign in as them. Either way the permission system stops
 * meaning anything, and the audit trail files it as ordinary administration.
 *
 * Two rules follow, and between them they close every route:
 *
 *  - Roles are an owner's decision. There is no partial version of "owner", so
 *    there is nothing to delegate.
 *  - Permissions may be delegated, but only downwards: you can give away what
 *    you hold and nothing more. A manager can set a new till assistant up with
 *    sales access if they have it themselves, and cannot conjure access to the
 *    accounts out of nothing.
 *
 * The actor's role and rights are read from the database on every check rather
 * than taken from the session or the caller. The session was minted before this
 * request and may predate a demotion; the caller is the thing being checked.
 */

type Reader = Db | Tx;

function readActor(db: Reader, actorId: number): { role: string; isActive: boolean } | null {
  return (
    db
      .select({ role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, actorId))
      .get() ?? null
  );
}

/** True when the actor is an owner in good standing right now. */
export function actorIsOwner(db: Reader, actorId: number): boolean {
  const row = readActor(db, actorId);
  return row !== null && row.isActive && row.role === 'OWNER';
}

export function assertActorIsOwner(
  db: Reader,
  actor: { id: number; username: string },
  what: string,
): void {
  if (!actorIsOwner(db, actor.id)) {
    throw new ForbiddenError(`only an owner can ${what}`);
  }
}

/**
 * Refuse to grant anything the actor does not already hold.
 *
 * Owners hold everything, so they pass without a lookup. For everyone else each
 * ticked box is checked against their own row for that module. Unticked boxes
 * are ignored: taking rights away from somebody is not an escalation.
 */
export function assertPermissionsGrantable(
  db: Reader,
  actor: { id: number; username: string },
  requested: PermissionMap,
): void {
  if (actorIsOwner(db, actor.id)) return;

  const own: PermissionMap = {};
  for (const row of db.select().from(userPermissions).where(eq(userPermissions.userId, actor.id)).all()) {
    own[row.module] = {
      canView: row.canView,
      canCreate: row.canCreate,
      canEdit: row.canEdit,
      canVoid: row.canVoid,
    };
  }

  for (const moduleName of PERMISSION_MODULES) {
    const want = requested[moduleName];
    if (!want) continue;
    const have = own[moduleName];

    const overreach =
      (want.canView && !have?.canView) ||
      (want.canCreate && !have?.canCreate) ||
      (want.canEdit && !have?.canEdit) ||
      (want.canVoid && !have?.canVoid);

    if (overreach) {
      throw new ForbiddenError(
        `only an owner can grant ${moduleName} access, because you do not hold it yourself`,
      );
    }
  }
}
