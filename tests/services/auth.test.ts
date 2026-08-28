import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { auditLogs, sessions, users } from '@/db/schema';
import {
  changePassword,
  createUser,
  login,
  MAX_FAILED_LOGINS,
  needsInitialSetup,
} from '@/services/auth.service';
import {
  invalidateSessionToken,
  purgeStaleSessions,
  SESSION_ABSOLUTE_MAX_DAYS,
  validateSessionToken,
} from '@/lib/auth/session';
import { can, defaultStaffPermissions, visibleModules } from '@/lib/auth/permissions';
import { ConflictError, ValidationError } from '@/domain/errors';

let context: TestDatabase;

const OWNER = {
  username: 'kwame',
  displayName: 'Kwame Owusu',
  password: 'adom-provisions-2026',
  role: 'OWNER' as const,
};

const STAFF = {
  username: 'ama',
  displayName: 'Ama Serwaa',
  password: 'counter-staff-2026',
  role: 'STAFF' as const,
  permissions: defaultStaffPermissions(),
};

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => {
  context.cleanup();
});

describe('initial setup', () => {
  it('reports that setup is needed on an empty database', () => {
    expect(needsInitialSetup(context.db)).toBe(true);
  });

  it('reports setup complete once an account exists', async () => {
    await createUser(context.db, OWNER);
    expect(needsInitialSetup(context.db)).toBe(false);
  });
});

describe('createUser', () => {
  it('creates an owner and never stores the password', async () => {
    const id = await createUser(context.db, OWNER);
    const user = context.db.select().from(users).where(eq(users.id, id)).get();

    expect(user?.role).toBe('OWNER');
    expect(user?.isActive).toBe(true);
    expect(user?.passwordHash).not.toContain(OWNER.password);
    expect(user?.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('rejects a duplicate username regardless of case', async () => {
    await createUser(context.db, OWNER);
    await expect(createUser(context.db, { ...OWNER, username: 'KWAME' })).rejects.toThrow(
      ConflictError,
    );
  });

  it('rejects an invalid username or a weak password', async () => {
    await expect(createUser(context.db, { ...OWNER, username: 'a b' })).rejects.toThrow(
      ValidationError,
    );
    await expect(createUser(context.db, { ...OWNER, password: 'short' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('stores permissions for staff', async () => {
    const id = await createUser(context.db, STAFF);
    const result = await login(context.db, {
      username: STAFF.username,
      password: STAFF.password,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.id).toBe(id);
    expect(result.principal.permissions['sales']?.canCreate).toBe(true);
    expect(result.principal.permissions['settings']).toBeUndefined();
  });

  it('rolls back completely if permission insertion fails', async () => {
    await expect(
      createUser(context.db, {
        ...STAFF,
        // An unknown module violates the database CHECK on `module`, failing
        // partway through the transaction after the user row was inserted.
        permissions: {
          nonsense: { canView: true, canCreate: false, canEdit: false, canVoid: false },
        } as never,
      }),
    ).rejects.toThrow(/CHECK constraint/i);

    // No half-created user is left behind.
    expect(context.db.select().from(users).all()).toHaveLength(0);
  });
});

describe('login', () => {
  beforeEach(async () => {
    await createUser(context.db, OWNER);
  });

  it('succeeds with correct credentials and issues a session', async () => {
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.token).toBeTruthy();
    expect(result.principal.role).toBe('OWNER');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const context2 = validateSessionToken(context.db, result.token);
    expect(context2?.principal.username).toBe(OWNER.username);
  });

  it('is case-insensitive on the username', async () => {
    const result = await login(context.db, { username: 'KWAME', password: OWNER.password });
    expect(result.ok).toBe(true);
  });

  it('fails on a wrong password', async () => {
    const result = await login(context.db, { username: OWNER.username, password: 'wrong-one' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('INVALID_CREDENTIALS');
  });

  it('fails on an unknown username with the same reason (no user enumeration)', async () => {
    const result = await login(context.db, { username: 'ghost', password: 'anything-at-all' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('INVALID_CREDENTIALS');
  });

  it('never stores the raw session token', async () => {
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = context.db.select().from(sessions).all();
    expect(rows).toHaveLength(1);
    // The row holds a SHA-256, so a stolen database cannot be replayed.
    expect(rows[0]?.id).not.toBe(result.token);
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('locks the account after repeated failures and releases it after the window', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await login(context.db, { username: OWNER.username, password: 'wrong' });
    }

    const locked = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    expect(locked.ok).toBe(false);
    if (locked.ok) return;
    expect(locked.reason).toBe('ACCOUNT_LOCKED');

    // Correct password still refused while locked...
    const later = new Date(Date.now() + 16 * 60 * 1000);
    const unlocked = await login(
      context.db,
      { username: OWNER.username, password: OWNER.password },
      {},
      later,
    );
    // ...and accepted once the lock expires.
    expect(unlocked.ok).toBe(true);
  });

  it('resets the failure count after a successful sign-in', async () => {
    await login(context.db, { username: OWNER.username, password: 'wrong' });
    await login(context.db, { username: OWNER.username, password: OWNER.password });

    const user = context.db.select().from(users).where(eq(users.username, OWNER.username)).get();
    expect(user?.failedLoginCount).toBe(0);
    expect(user?.lockedUntil).toBeNull();
    expect(user?.lastLoginAt).not.toBeNull();
  });

  it('refuses a deactivated account even with the right password', async () => {
    context.db.update(users).set({ isActive: false }).where(eq(users.username, OWNER.username)).run();

    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ACCOUNT_INACTIVE');
  });

  it('writes audit records for success and failure without the password', async () => {
    await login(context.db, { username: OWNER.username, password: 'wrong-password-here' });
    await login(context.db, { username: OWNER.username, password: OWNER.password });

    const entries = context.db.select().from(auditLogs).all();
    const actions = entries.map((entry) => entry.action);

    expect(actions).toContain('LOGIN_FAILED');
    expect(actions).toContain('LOGIN_SUCCESS');
    expect(JSON.stringify(entries)).not.toContain('wrong-password-here');
    expect(JSON.stringify(entries)).not.toContain(OWNER.password);
  });
});

describe('sessions', () => {
  it('rejects an unknown, revoked or expired token', async () => {
    await createUser(context.db, OWNER);
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(validateSessionToken(context.db, 'not-a-real-token')).toBeNull();
    expect(validateSessionToken(context.db, '')).toBeNull();

    // Expired.
    const future = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(validateSessionToken(context.db, result.token, future)).toBeNull();
  });

  it('signs the user out on invalidate', async () => {
    await createUser(context.db, OWNER);
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    if (!result.ok) throw new Error('login failed');

    invalidateSessionToken(context.db, result.token);
    expect(validateSessionToken(context.db, result.token)).toBeNull();
  });

  it('stops working the moment the account is deactivated', async () => {
    await createUser(context.db, OWNER);
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    if (!result.ok) throw new Error('login failed');

    expect(validateSessionToken(context.db, result.token)).not.toBeNull();
    context.db.update(users).set({ isActive: false }).where(eq(users.username, OWNER.username)).run();
    expect(validateSessionToken(context.db, result.token)).toBeNull();
  });

  it('invalidates every session when the password changes', async () => {
    const id = await createUser(context.db, OWNER);
    const first = await login(context.db, { username: OWNER.username, password: OWNER.password });
    const second = await login(context.db, { username: OWNER.username, password: OWNER.password });
    if (!first.ok || !second.ok) throw new Error('login failed');

    await changePassword(context.db, id, 'a-brand-new-password', {
      id,
      username: OWNER.username,
    });

    expect(validateSessionToken(context.db, first.token)).toBeNull();
    expect(validateSessionToken(context.db, second.token)).toBeNull();

    // The new password works, the old one does not.
    expect((await login(context.db, { username: OWNER.username, password: OWNER.password })).ok).toBe(
      false,
    );
    expect(
      (await login(context.db, { username: OWNER.username, password: 'a-brand-new-password' })).ok,
    ).toBe(true);
  });

  it('purges stale sessions', async () => {
    await createUser(context.db, OWNER);
    await login(context.db, { username: OWNER.username, password: OWNER.password });

    expect(context.db.select().from(sessions).all()).toHaveLength(1);
    const removed = purgeStaleSessions(context.db, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(removed).toBe(1);
    expect(context.db.select().from(sessions).all()).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('gives the owner everything, without any permission rows', async () => {
    await createUser(context.db, OWNER);
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    if (!result.ok) throw new Error('login failed');

    const owner = result.principal;
    expect(can(owner, 'settings', 'edit')).toBe(true);
    expect(can(owner, 'sales', 'void')).toBe(true);
    expect(can(owner, 'users', 'create')).toBe(true);
    expect(visibleModules(owner).length).toBeGreaterThan(10);
  });

  it('restricts staff to their granted modules', async () => {
    await createUser(context.db, STAFF);
    const result = await login(context.db, {
      username: STAFF.username,
      password: STAFF.password,
    });
    if (!result.ok) throw new Error('login failed');

    const staff = result.principal;
    expect(can(staff, 'sales', 'create')).toBe(true);
    expect(can(staff, 'sales', 'void')).toBe(false);
    expect(can(staff, 'settings', 'view')).toBe(false);
    expect(can(staff, 'users', 'create')).toBe(false);
    expect(can(staff, 'reports', 'view')).toBe(false);

    expect(visibleModules(staff)).not.toContain('settings');
    expect(visibleModules(staff)).toContain('sales');
  });

  it('does not let a write permission bypass a missing view permission', async () => {
    const staff = {
      role: 'STAFF' as const,
      permissions: {
        expenses: { canView: false, canCreate: true, canEdit: true, canVoid: true },
      },
    };
    // Granting "create" without "view" is a configuration mistake, not a
    // back door into the module.
    expect(can(staff, 'expenses', 'create')).toBe(false);
    expect(can(staff, 'expenses', 'edit')).toBe(false);
    expect(can(staff, 'expenses', 'void')).toBe(false);
  });
});

describe('after a lockout has been served', () => {
  /**
   * Serving the lockout has to actually give the attempts back.
   *
   * The counter was only cleared by signing in SUCCESSFULLY. Once an account
   * had tripped the limit, the count stayed at the limit for ever — so the next
   * wrong password, however long afterwards, immediately crossed it again and
   * locked the account for another full window. Someone who mistyped their
   * password five times one morning was reduced to one attempt every fifteen
   * minutes, permanently, and nothing on the screen explained why.
   */
  beforeEach(async () => {
    await createUser(context.db, OWNER);
  });

  const afterLockout = () => new Date(Date.now() + 16 * 60 * 1000);

  async function tripTheLock(): Promise<void> {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await login(context.db, { username: OWNER.username, password: 'wrong' });
    }
  }

  it('gives back a full set of attempts, not one', async () => {
    await tripTheLock();

    const at = afterLockout();
    // One more slip should NOT re-lock the account.
    await login(context.db, { username: OWNER.username, password: 'wrong-again' }, {}, at);

    const user = context.db.select().from(users).where(eq(users.username, OWNER.username)).get();
    expect(user?.failedLoginCount).toBe(1);
    expect(user?.lockedUntil).toBeNull();
  });

  it('still lets the right password through after a slip', async () => {
    await tripTheLock();

    const at = afterLockout();
    await login(context.db, { username: OWNER.username, password: 'wrong-again' }, {}, at);

    const result = await login(
      context.db,
      { username: OWNER.username, password: OWNER.password },
      {},
      at,
    );
    expect(result.ok).toBe(true);
  });

  it('still locks again after another full run of failures', async () => {
    await tripTheLock();

    const at = afterLockout();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await login(context.db, { username: OWNER.username, password: 'wrong' }, {}, at);
    }

    const result = await login(
      context.db,
      { username: OWNER.username, password: OWNER.password },
      {},
      at,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ACCOUNT_LOCKED');
    // Two full runs of failed sign-ins, each one hashing a password for real
    // rather than against a stub — which is the whole point, since a password
    // check that is cheap to run is cheap to attack. Slow by design; see the
    // timeout note in vitest.config.ts.
  });
});

describe('how long a session lives', () => {
  /**
   * The session slides forward while somebody keeps working, so a busy day does
   * not end with an unexplained sign-out. Two things follow.
   *
   * The browser cookie has to outlive the sliding, or the slide achieves
   * nothing: the server kept the session alive and the browser threw its half
   * away on the original deadline. The cookie is only the carrier — the
   * database decides whether a session is still good.
   *
   * And sliding cannot go on for ever. A session that renews itself every time
   * it is used never expires at all, which is not a session, it is a permanent
   * key. There is an absolute ceiling from the moment of sign-in.
   */
  beforeEach(async () => {
    await createUser(context.db, OWNER);
  });

  async function signIn(): Promise<string> {
    const result = await login(context.db, {
      username: OWNER.username,
      password: OWNER.password,
    });
    if (!result.ok) throw new Error('expected the sign-in to succeed');
    return result.token;
  }

  it('keeps sliding while the person keeps working', async () => {
    const token = await signIn();

    // Six days later, still working: the session must carry on.
    const day6 = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(validateSessionToken(context.db, token, day6)).not.toBeNull();

    // And the slide must have pushed the deadline past the original week.
    const day9 = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    expect(validateSessionToken(context.db, token, day9)).not.toBeNull();
  });

  it('expires when the person stops working', async () => {
    const token = await signIn();

    const day8 = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(validateSessionToken(context.db, token, day8)).toBeNull();
  });

  it('stops sliding at the absolute ceiling, however busy the shop is', async () => {
    const token = await signIn();

    // Opened every single day, the way a till is.
    for (let day = 1; day < SESSION_ABSOLUTE_MAX_DAYS; day++) {
      const at = new Date(Date.now() + day * 24 * 60 * 60 * 1000);
      expect(validateSessionToken(context.db, token, at), `day ${day}`).not.toBeNull();
    }

    const pastTheCeiling = new Date(
      Date.now() + (SESSION_ABSOLUTE_MAX_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    expect(validateSessionToken(context.db, token, pastTheCeiling)).toBeNull();
  });
});
