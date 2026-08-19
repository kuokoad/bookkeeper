import { createHash, randomBytes } from 'node:crypto';
import { eq, isNotNull, lt, or } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { sessions, userPermissions, users } from '@/db/schema';
import type { Principal, PermissionMap } from './permissions';
import type { PermissionModule } from '@/db/schema/users';

/**
 * Server-side session management.
 *
 * The cookie holds a random opaque token. The database stores only the SHA-256
 * of that token, so someone who copies the shop's database file still cannot
 * mint a working session cookie from it.
 */

export const SESSION_COOKIE_NAME = 'bk_session';

/** Idle lifetime. A shop PC is shared, so this is deliberately not months. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Slide the expiry forward when less than this remains. */
const RENEW_WHEN_REMAINING_MS = 24 * 60 * 60 * 1000;

/**
 * The ceiling on how long one sign-in can be stretched.
 *
 * Sliding the expiry means somebody working through the week is not thrown out
 * mid-sale. Sliding it without a ceiling means a session that is used often
 * enough never expires at all — which is not a session, it is a permanent key
 * cut from one password entry, and on a shared shop PC it outlives the reason
 * it was issued. Measured from sign-in, not from last use.
 */
export const SESSION_ABSOLUTE_MAX_DAYS = 30;
export const SESSION_ABSOLUTE_MAX_MS = SESSION_ABSOLUTE_MAX_DAYS * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

export interface SessionContext {
  principal: Principal;
  sessionId: string;
  expiresAt: Date;
}

/** SHA-256 of the token — this, not the token, is the primary key. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface SessionMetadata {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** Create a session row and return the raw token to put in the cookie. */
export function createSession(
  db: Db,
  userId: number,
  metadata: SessionMetadata = {},
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  db.insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      expiresAt,
      lastSeenAt: now,
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      createdAt: now,
    })
    .run();

  return { token, expiresAt };
}

function loadPermissions(db: Db, userId: number): PermissionMap {
  const rows = db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId))
    .all();

  const map: PermissionMap = {};
  for (const row of rows) {
    map[row.module as PermissionModule] = {
      canView: row.canView,
      canCreate: row.canCreate,
      canEdit: row.canEdit,
      canVoid: row.canVoid,
    };
  }
  return map;
}

/**
 * Validate a token and return the principal, or null.
 *
 * Returns null — never throws — for every failure mode (unknown, expired,
 * revoked, deactivated user), so callers cannot accidentally distinguish them
 * and leak information.
 */
export function validateSessionToken(
  db: Db,
  token: string,
  now: Date = new Date(),
): SessionContext | null {
  if (!token) return null;

  const sessionId = hashToken(token);

  const row = db
    .select({
      session: sessions,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .get();

  if (!row) return null;

  const { session, user } = row;

  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= now.getTime()) {
    // Expired sessions are cleaned up opportunistically.
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }
  if (!user.isActive) return null;

  // However busy the shop, one sign-in does not last for ever.
  const hardDeadline = session.createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS;
  if (hardDeadline <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }

  // Slide the expiry forward for an active user, but never past the ceiling.
  let expiresAt = session.expiresAt;
  if (expiresAt.getTime() - now.getTime() < RENEW_WHEN_REMAINING_MS) {
    expiresAt = new Date(Math.min(now.getTime() + SESSION_TTL_MS, hardDeadline));
    db.update(sessions).set({ expiresAt, lastSeenAt: now }).where(eq(sessions.id, sessionId)).run();
  } else {
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId)).run();
  }

  return {
    sessionId,
    expiresAt,
    principal: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      permissions: user.role === 'OWNER' ? {} : loadPermissions(db, user.id),
    },
  };
}

export function invalidateSessionToken(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}

/** Used when a password changes or an account is deactivated. */
export function invalidateAllUserSessions(db: Db, userId: number): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

/** Housekeeping: drop rows that are expired or explicitly revoked. */
export function purgeStaleSessions(db: Db, now: Date = new Date()): number {
  const result = db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), isNotNull(sessions.revokedAt)))
    .run();
  return result.changes;
}
