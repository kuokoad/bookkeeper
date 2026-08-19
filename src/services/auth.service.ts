import { eq, sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { userPermissions, users, type UserRole } from '@/db/schema';
import { hashPassword, hashPin, needsRehash, verifyPassword } from '@/lib/auth/password';
import { createSession, invalidateAllUserSessions, type SessionMetadata } from '@/lib/auth/session';
import type { PermissionMap, Principal } from '@/lib/auth/permissions';
import { writeAudit } from './audit.service';
import { assertActorIsOwner, assertPermissionsGrantable } from './role-guard';
import { ConflictError, ValidationError } from '@/domain/errors';

/**
 * Authentication operations.
 *
 * Password verification is asynchronous and deliberately performed OUTSIDE any
 * database transaction: better-sqlite3 transactions are synchronous, and
 * awaiting inside one is not possible. The subsequent database writes are
 * individually small and idempotent.
 */

/** Consecutive failures before the account is temporarily locked. */
export const MAX_FAILED_LOGINS = 5;
/** How long the lock lasts. Long enough to stop guessing, short enough to trade. */
export const LOCKOUT_MS = 15 * 60 * 1000;

export type LoginFailureReason =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_INACTIVE';

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; principal: Principal; mustChangePassword: boolean }
  | { ok: false; reason: LoginFailureReason; lockedUntil?: Date };

/**
 * A throwaway hash used when the username does not exist, so that a failed
 * lookup costs the same time as a wrong password. Without it, response timing
 * would reveal which usernames are real.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('not-a-real-password-placeholder');
  return dummyHashPromise;
}

export async function login(
  db: Db,
  input: { username: string; password: string },
  metadata: SessionMetadata = {},
  now: Date = new Date(),
): Promise<LoginResult> {
  const username = input.username.trim();

  const user = db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .get();

  if (!user) {
    // Spend the same effort as a real verification before answering.
    await verifyPassword(input.password, await dummyHash());
    recordFailedAttempt(db, null, username, metadata, now);
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    writeAudit(db, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      username: user.username,
      summary: `Login attempt while account locked until ${user.lockedUntil.toISOString()}`,
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      at: now,
    });
    return { ok: false, reason: 'ACCOUNT_LOCKED', lockedUntil: user.lockedUntil };
  }

  const passwordMatches = await verifyPassword(input.password, user.passwordHash);

  if (!passwordMatches) {
    recordFailedAttempt(db, user.id, user.username, metadata, now);
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  // Correct password, but the account has been switched off. Checked AFTER the
  // password so a deactivated account is not distinguishable by a guesser.
  if (!user.isActive) {
    writeAudit(db, {
      action: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      username: user.username,
      summary: 'Login attempt on a deactivated account',
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      at: now,
    });
    return { ok: false, reason: 'ACCOUNT_INACTIVE' };
  }

  // Transparently upgrade a hash created under weaker parameters.
  let passwordHash = user.passwordHash;
  if (needsRehash(passwordHash)) {
    passwordHash = await hashPassword(input.password);
  }

  const permissions: PermissionMap =
    user.role === 'OWNER' ? {} : loadPermissionMap(db, user.id);

  const session = createSession(db, user.id, metadata, now);

  db.update(users)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: now,
      passwordHash,
      updatedAt: now,
    })
    .where(eq(users.id, user.id))
    .run();

  writeAudit(db, {
    action: 'LOGIN_SUCCESS',
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
    username: user.username,
    summary: `${user.displayName} signed in`,
    ipAddress: metadata.ipAddress ?? null,
    userAgent: metadata.userAgent ?? null,
    at: now,
  });

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    mustChangePassword: user.mustChangePassword,
    principal: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions,
    },
  };
}

/**
 * Fast sign-in with a short PIN, for switching staff at the till.
 *
 * A 4-6 digit PIN has far less entropy than a password, so it is protected by
 * the SAME lockout counter — five wrong PINs lock the account exactly as five
 * wrong passwords would. It is a convenience on a device already inside the
 * shop, never a replacement for the password.
 */
export async function loginWithPin(
  db: Db,
  input: { username: string; pin: string },
  metadata: SessionMetadata = {},
  now: Date = new Date(),
): Promise<LoginResult> {
  const username = input.username.trim();

  const user = db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .get();

  if (!user || user.pinHash === null) {
    // Same cost and same answer as a wrong PIN, so "this user has no PIN" is
    // not detectable from the outside.
    await verifyPassword(input.pin, await dummyHash());
    recordFailedAttempt(db, user?.id ?? null, username, metadata, now);
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    return { ok: false, reason: 'ACCOUNT_LOCKED', lockedUntil: user.lockedUntil };
  }

  if (!(await verifyPassword(input.pin, user.pinHash))) {
    recordFailedAttempt(db, user.id, user.username, metadata, now);
    return { ok: false, reason: 'INVALID_CREDENTIALS' };
  }

  if (!user.isActive) {
    return { ok: false, reason: 'ACCOUNT_INACTIVE' };
  }

  const session = createSession(db, user.id, metadata, now);

  db.update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, user.id))
    .run();

  writeAudit(db, {
    action: 'LOGIN_SUCCESS',
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
    username: user.username,
    summary: `${user.displayName} signed in with a PIN`,
    ipAddress: metadata.ipAddress ?? null,
    userAgent: metadata.userAgent ?? null,
    at: now,
  });

  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    mustChangePassword: user.mustChangePassword,
    principal: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: user.role === 'OWNER' ? {} : loadPermissionMap(db, user.id),
    },
  };
}

function recordFailedAttempt(
  db: Db,
  userId: number | null,
  username: string,
  metadata: SessionMetadata,
  now: Date,
): void {
  if (userId !== null) {
    const current = db.select().from(users).where(eq(users.id, userId)).get();

    /**
     * Serving the lockout gives the attempts back.
     *
     * The count used to be cleared only by signing in SUCCESSFULLY, so once an
     * account had tripped the limit the count stayed at the limit for ever. The
     * next wrong password — that afternoon, or a month later — crossed it again
     * immediately and locked the account for another full window. Someone who
     * mistyped five times one morning was left with one attempt every fifteen
     * minutes, permanently, with nothing on screen to explain it.
     *
     * The lockout is meant to slow a guesser down, not to punish the person who
     * owns the account into needing an owner to rescue them.
     */
    const lockedUntil = current?.lockedUntil ?? null;
    const lockHasExpired = lockedUntil !== null && lockedUntil.getTime() <= now.getTime();

    const previousCount = lockHasExpired ? 0 : (current?.failedLoginCount ?? 0);
    const failedCount = previousCount + 1;
    const shouldLock = failedCount >= MAX_FAILED_LOGINS;

    db.update(users)
      .set({
        failedLoginCount: failedCount,
        lockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_MS) : null,
        updatedAt: now,
      })
      .where(eq(users.id, userId))
      .run();
  }

  writeAudit(db, {
    action: 'LOGIN_FAILED',
    entityType: 'user',
    entityId: userId,
    userId,
    username,
    // The attempted password is never recorded.
    summary: `Failed sign-in attempt for "${username}"`,
    ipAddress: metadata.ipAddress ?? null,
    userAgent: metadata.userAgent ?? null,
    at: now,
  });
}

function loadPermissionMap(db: Db, userId: number): PermissionMap {
  const rows = db.select().from(userPermissions).where(eq(userPermissions.userId, userId)).all();
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

// --- user management -------------------------------------------------------

export interface CreateUserInput {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
  pin?: string;
  permissions?: PermissionMap;
  mustChangePassword?: boolean;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;

export async function createUser(
  db: Db,
  input: CreateUserInput,
  actor: { id: number; username: string } | null = null,
  now: Date = new Date(),
): Promise<number> {
  const username = input.username.trim();

  if (!USERNAME_PATTERN.test(username)) {
    throw new ValidationError(
      'Username must be 3-40 characters and contain only letters, numbers, dots, dashes or underscores.',
    );
  }
  if (input.displayName.trim().length < 2) {
    throw new ValidationError('Enter the person’s name.');
  }

  const existing = db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .get();
  if (existing) {
    throw new ConflictError('That username is already taken.');
  }

  /**
   * A null actor is first-run setup, where there is nobody to be an owner yet.
   * Once the shop has an owner, creating an account that outranks you — or a
   * staff account carrying rights you were never given — is escalation with one
   * extra sign-in in the middle, so both are owners-only.
   */
  if (actor !== null) {
    if (input.role === 'OWNER') assertActorIsOwner(db, actor, 'create an owner account');
    if (input.permissions) assertPermissionsGrantable(db, actor, input.permissions);
  }

  // Hashing happens before the transaction — it is async and CPU-bound.
  const passwordHash = await hashPassword(input.password);
  const pinHash = input.pin ? await hashPin(input.pin) : null;

  return db.transaction((tx) => {
    const inserted = tx
      .insert(users)
      .values({
        username,
        displayName: input.displayName.trim(),
        role: input.role,
        passwordHash,
        pinHash,
        isActive: true,
        mustChangePassword: input.mustChangePassword ?? false,
        createdBy: actor?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the user account.');

    // OWNER bypasses the permission table entirely, so rows would be misleading.
    if (input.role === 'STAFF' && input.permissions) {
      for (const [module, permission] of Object.entries(input.permissions)) {
        if (!permission) continue;
        tx.insert(userPermissions)
          .values({
            userId: inserted.id,
            module: module as keyof PermissionMap,
            canView: permission.canView,
            canCreate: permission.canCreate,
            canEdit: permission.canEdit,
            canVoid: permission.canVoid,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    }

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'user',
      entityId: inserted.id,
      userId: actor?.id ?? null,
      username: actor?.username ?? null,
      summary: `Created ${input.role.toLowerCase()} account "${username}"`,
      metadata: { role: input.role, displayName: input.displayName },
      at: now,
    });

    return inserted.id;
  });
}

/** Changing a password invalidates every existing session for that user. */
export async function changePassword(
  db: Db,
  userId: number,
  newPassword: string,
  actor: { id: number; username: string },
  now: Date = new Date(),
): Promise<void> {
  const passwordHash = await hashPassword(newPassword);

  db.transaction((tx) => {
    const updated = tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: now })
      .where(eq(users.id, userId))
      .returning({ id: users.id, username: users.username })
      .get();

    if (!updated) throw new ValidationError('That user account no longer exists.');

    invalidateAllUserSessions(tx, userId);

    writeAudit(tx, {
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: userId,
      userId: actor.id,
      username: actor.username,
      summary: `Password changed for "${updated.username}"; all sessions signed out`,
      at: now,
    });
  });
}

/** True when the shop has no user accounts at all — gates the first-run setup. */
export function needsInitialSetup(db: Db): boolean {
  const row = db.select({ count: sql<number>`count(*)` }).from(users).get();
  return (row?.count ?? 0) === 0;
}
