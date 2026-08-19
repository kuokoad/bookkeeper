import { and, asc, eq, ne, sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { userPermissions, users, type UserRole } from '@/db/schema';
import { PERMISSION_MODULES, type PermissionModule } from '@/db/schema/users';
import type { ModulePermission, PermissionMap } from '@/lib/auth/permissions';
import { hashPassword, hashPin, verifyPassword } from '@/lib/auth/password';
import { invalidateAllUserSessions } from '@/lib/auth/session';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';
import { assertActorIsOwner, assertPermissionsGrantable } from './role-guard';

/**
 * Managing people.
 *
 * The guards here exist to stop the shop locking itself out or quietly losing
 * its oversight: the last owner cannot be removed, demoted or deactivated, and
 * nobody can switch off their own account. Every one of those is recoverable
 * only by editing the database by hand, which a shop owner cannot do.
 */

export interface UserListItem {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  hasPin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  /**
   * Whether the lockout is still in force as of this read. Decided here rather
   * than in the page, so the answer is settled on the server at one moment
   * instead of being recomputed on every render.
   */
  isLocked: boolean;
  failedLoginCount: number;
  moduleCount: number;
  createdAt: Date;
}

export function listUsers(db: Db): UserListItem[] {
  const asOf = Date.now();
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
      pinHash: users.pinHash,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      lockedUntil: users.lockedUntil,
      failedLoginCount: users.failedLoginCount,
      createdAt: users.createdAt,
      moduleCount: sql<number>`(
        SELECT COUNT(*) FROM user_permissions up
        WHERE up.user_id = users.id AND up.can_view = 1
      )`,
    })
    .from(users)
    .orderBy(asc(users.displayName))
    .all()
    .map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      isActive: row.isActive,
      hasPin: row.pinHash !== null,
      mustChangePassword: row.mustChangePassword,
      lastLoginAt: row.lastLoginAt,
      lockedUntil: row.lockedUntil,
      isLocked: row.lockedUntil !== null && row.lockedUntil.getTime() > asOf,
      failedLoginCount: row.failedLoginCount,
      // An owner is not subject to the permission table at all.
      moduleCount: row.role === 'OWNER' ? PERMISSION_MODULES.length : row.moduleCount,
      createdAt: row.createdAt,
    }));
}

export function getUserPermissions(db: Db, userId: number): PermissionMap {
  const rows = db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId))
    .all();

  const map: PermissionMap = {};
  for (const row of rows) {
    map[row.module] = {
      canView: row.canView,
      canCreate: row.canCreate,
      canEdit: row.canEdit,
      canVoid: row.canVoid,
    };
  }
  return map;
}

export function getUser(db: Db, id: number): UserListItem {
  const found = listUsers(db).find((user) => user.id === id);
  if (!found) throw new NotFoundError('User', id);
  return found;
}

/** How many owners can still sign in. */
function activeOwnerCount(db: Db, excludingId?: number): number {
  const conditions = [eq(users.role, 'OWNER'), eq(users.isActive, true)];
  if (excludingId !== undefined) conditions.push(ne(users.id, excludingId));

  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .where(and(...conditions))
    .get();
  return row?.count ?? 0;
}

export interface UpdateUserInput {
  displayName: string;
  role: UserRole;
}

export function updateUser(db: Db, id: number, input: UpdateUserInput, actor: Actor): void {
  if (input.displayName.trim().length < 2) {
    throw new ValidationError('Enter the person’s name.');
  }

  db.transaction((tx) => {
    const existing = tx.select().from(users).where(eq(users.id, id)).get();
    if (!existing) throw new NotFoundError('User', id);

    if (existing.role !== input.role) {
      // Changing what somebody may do is an owner's decision, not a chore that
      // comes with the `users` permission. See role-guard.ts.
      assertActorIsOwner(tx, actor, 'change a person’s role');

      // Even an owner does not do this to themselves. Self-promotion is the
      // hole this guard exists to close, and an owner stepping down should be
      // stepped down by another owner so the change has a second pair of eyes.
      if (id === actor.id) {
        throw new ConflictError(
          'You cannot change your own role. Another owner has to do that for you.',
        );
      }
    }

    // Demoting the last owner would leave nobody able to manage the shop.
    if (existing.role === 'OWNER' && input.role !== 'OWNER' && activeOwnerCount(tx, id) === 0) {
      throw new ConflictError(
        'This is the only owner. Make someone else an owner first, otherwise nobody could manage the shop.',
      );
    }

    const now = new Date();
    tx.update(users)
      .set({ displayName: input.displayName.trim(), role: input.role, updatedAt: now })
      .where(eq(users.id, id))
      .run();

    // Permission rows are meaningless for an owner, who bypasses them entirely.
    if (input.role === 'OWNER' && existing.role !== 'OWNER') {
      tx.delete(userPermissions).where(eq(userPermissions.userId, id)).run();
    }

    // A role change alters what this person may do, so their existing sessions
    // must not keep running on the old rights.
    if (existing.role !== input.role) {
      invalidateAllUserSessions(tx, id);
    }

    writeAudit(tx, {
      action: existing.role === input.role ? 'UPDATE' : 'PERMISSION_CHANGE',
      entityType: 'user',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary:
        existing.role === input.role
          ? `Updated ${existing.username}`
          : `Changed ${existing.username} from ${existing.role} to ${input.role}`,
      metadata: {
        before: { displayName: existing.displayName, role: existing.role },
        after: { displayName: input.displayName.trim(), role: input.role },
      },
      at: now,
    });
  });
}

export function setUserActive(
  db: Db,
  id: number,
  isActive: boolean,
  actor: Actor,
): void {
  db.transaction((tx) => {
    const existing = tx.select().from(users).where(eq(users.id, id)).get();
    if (!existing) throw new NotFoundError('User', id);

    if (!isActive) {
      if (id === actor.id) {
        throw new ConflictError('You cannot switch off your own account.');
      }
      if (existing.role === 'OWNER' && activeOwnerCount(tx, id) === 0) {
        throw new ConflictError(
          'This is the only active owner. Switching it off would lock everyone out of the shop.',
        );
      }
    }

    const now = new Date();
    tx.update(users).set({ isActive, updatedAt: now }).where(eq(users.id, id)).run();

    // Someone switched off must stop working immediately, not when their
    // session happens to expire.
    if (!isActive) invalidateAllUserSessions(tx, id);

    writeAudit(tx, {
      action: isActive ? 'RESTORE' : 'ARCHIVE',
      entityType: 'user',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${isActive ? 'Reactivated' : 'Switched off'} ${existing.username}`,
      at: now,
    });
  });
}

export function setUserPermissions(
  db: Db,
  id: number,
  permissions: PermissionMap,
  actor: Actor,
): void {
  db.transaction((tx) => {
    // Rewriting your own row is the shortest route to more rights, and there is
    // no legitimate reason to do it: nobody needs to grant themselves what they
    // already have.
    if (id === actor.id) {
      throw new ConflictError(
        'You cannot change your own permissions. Another owner has to do that for you.',
      );
    }
    // Ticking boxes for a colleague and then signing in as them is the same
    // escalation with one extra step, so only rights you hold can be passed on.
    assertPermissionsGrantable(tx, actor, permissions);

    const existing = tx.select().from(users).where(eq(users.id, id)).get();
    if (!existing) throw new NotFoundError('User', id);
    if (existing.role === 'OWNER') {
      throw new ValidationError(
        'An owner already has full access, so there is nothing to set here.',
      );
    }

    const now = new Date();
    const before = getUserPermissions(tx as unknown as Db, id);

    tx.delete(userPermissions).where(eq(userPermissions.userId, id)).run();

    for (const moduleName of PERMISSION_MODULES) {
      const permission = permissions[moduleName];
      if (!permission) continue;
      // A row granting nothing is noise; leaving it out means the same thing.
      if (!permission.canView && !permission.canCreate && !permission.canEdit && !permission.canVoid) {
        continue;
      }

      tx.insert(userPermissions)
        .values({
          userId: id,
          module: moduleName,
          canView: permission.canView,
          canCreate: permission.canCreate,
          canEdit: permission.canEdit,
          canVoid: permission.canVoid,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Their open sessions carry the old rights in memory, so end them.
    invalidateAllUserSessions(tx, id);

    writeAudit(tx, {
      action: 'PERMISSION_CHANGE',
      entityType: 'user',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Changed what ${existing.username} can do`,
      metadata: { before, after: permissions },
      at: now,
    });
  });
}

/**
 * Owner resets someone's password.
 *
 * The new password must be changed by that person on next sign-in, so the
 * owner does not keep knowing a working credential for someone else's account.
 */
export async function resetUserPassword(
  db: Db,
  id: number,
  newPassword: string,
  actor: Actor,
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);

  db.transaction((tx) => {
    const existing = tx.select().from(users).where(eq(users.id, id)).get();
    if (!existing) throw new NotFoundError('User', id);

    const now = new Date();
    tx.update(users)
      .set({
        passwordHash,
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(eq(users.id, id))
      .run();

    invalidateAllUserSessions(tx, id);

    writeAudit(tx, {
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Reset the password for ${existing.username}; they must set a new one on next sign-in`,
      at: now,
    });
  });
}

/**
 * Someone changing their OWN password.
 * Requires the current one, so a walked-away session cannot be hijacked into a
 * permanent takeover of the account.
 */
export async function changeOwnPassword(
  db: Db,
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const existing = db.select().from(users).where(eq(users.id, userId)).get();
  if (!existing) throw new NotFoundError('User', userId);

  if (!(await verifyPassword(currentPassword, existing.passwordHash))) {
    throw new ValidationError('Your current password is not correct.');
  }
  if (await verifyPassword(newPassword, existing.passwordHash)) {
    throw new ValidationError('The new password must be different from the current one.');
  }

  const passwordHash = await hashPassword(newPassword);

  db.transaction((tx) => {
    const now = new Date();
    tx.update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: now })
      .where(eq(users.id, userId))
      .run();

    // Every OTHER session is ended; this one keeps working so the person is not
    // thrown out immediately after doing the right thing.
    invalidateAllUserSessions(tx, userId);

    writeAudit(tx, {
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: userId,
      userId,
      username: existing.username,
      summary: `${existing.username} changed their own password`,
      at: now,
    });
  });
}

/** A short PIN for fast switching at the till. Never a substitute for the password. */
export async function setUserPin(
  db: Db,
  id: number,
  pin: string | null,
  actor: Actor,
): Promise<void> {
  const pinHash = pin === null ? null : await hashPin(pin);

  db.transaction((tx) => {
    const existing = tx.select().from(users).where(eq(users.id, id)).get();
    if (!existing) throw new NotFoundError('User', id);

    const now = new Date();
    tx.update(users).set({ pinHash, updatedAt: now }).where(eq(users.id, id)).run();

    writeAudit(tx, {
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: pin === null ? `Removed the till PIN for ${existing.username}` : `Set a till PIN for ${existing.username}`,
      at: now,
    });
  });
}

/** Release a lockout early, when the owner knows the person simply forgot. */
export function unlockUser(db: Db, id: number, actor: Actor): void {
  db.transaction((tx) => {
    const existing = tx.select().from(users).where(eq(users.id, id)).get();
    if (!existing) throw new NotFoundError('User', id);

    const now = new Date();
    tx.update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, id))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'user',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Unlocked ${existing.username} after failed sign-in attempts`,
      at: now,
    });
  });
}

/** Blank permissions for every module, for the editor to fill in. */
export function emptyPermissionMatrix(): Record<PermissionModule, ModulePermission> {
  const matrix = {} as Record<PermissionModule, ModulePermission>;
  for (const moduleName of PERMISSION_MODULES) {
    matrix[moduleName] = { canView: false, canCreate: false, canEdit: false, canVoid: false };
  }
  return matrix;
}
