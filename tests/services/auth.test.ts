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
