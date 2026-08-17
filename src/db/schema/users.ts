import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { boolean, createdAt, timestampMs, updatedAt } from './_shared';
import { oneOf } from './_check';

export const USER_ROLES = ['OWNER', 'STAFF'] as const;

/**
 * Modules that permissions can be granted against. Kept as a const tuple so the
 * permission matrix in the UI and the server-side checks cannot drift apart.
 */
export const PERMISSION_MODULES = [
  'sales',
  'purchases',
  'inventory',
  'products',
  'customers',
  'suppliers',
  'expenses',
  'income',
  'accounts',
  'reports',
  'reconciliation',
  'users',
  'settings',
] as const;

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('STAFF'),

    /**
     * Full PHC-style encoded hash: "scrypt$N$r$p$<salt-b64>$<hash-b64>".
     * The algorithm and its parameters travel with the hash, so passwords can be
     * transparently re-hashed if the cost is raised later. Never a bare digest.
     */
    passwordHash: text('password_hash').notNull(),

    /** Optional short PIN for fast POS login. Hashed with the same scheme. */
    pinHash: text('pin_hash'),

    isActive: boolean('is_active').notNull().default(true),

    /** Login throttling — resets on success. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestampMs('locked_until'),

    lastLoginAt: timestampMs('last_login_at'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),

    createdBy: integer('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Case-insensitive uniqueness: "Ama" and "ama" must not be two accounts.
    uniqueIndex('uq_users_username').on(sql`lower(${t.username})`),
    index('idx_users_active').on(t.isActive),
    check('ck_users_username_len', sql`length(${t.username}) BETWEEN 3 AND 40`),
    check('ck_users_failed_login_count', sql`${t.failedLoginCount} >= 0`),
    check('ck_users_role', oneOf(t.role, USER_ROLES)),
  ],
);

/**
 * Server-side sessions.
 *
 * `id` stores the SHA-256 of the session token, never the token itself, so a
 * stolen copy of the database file cannot be replayed as a live login.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    expiresAt: timestampMs('expires_at').notNull(),
    lastSeenAt: timestampMs('last_seen_at').notNull(),
    revokedAt: timestampMs('revoked_at'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_sessions_user').on(t.userId),
    index('idx_sessions_expires').on(t.expiresAt),
  ],
);

/**
 * Per-module permission flags for STAFF users.
 * OWNER bypasses this table entirely and always has full access.
 */
export const userPermissions = sqliteTable(
  'user_permissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    module: text('module', { enum: PERMISSION_MODULES }).notNull(),

    canView: boolean('can_view').notNull().default(false),
    canCreate: boolean('can_create').notNull().default(false),
    canEdit: boolean('can_edit').notNull().default(false),
    /** Voiding/reversing a financial document is the highest-risk action. */
    canVoid: boolean('can_void').notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_user_permissions_user_module').on(t.userId, t.module),
    check('ck_user_permissions_module', oneOf(t.module, PERMISSION_MODULES)),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type UserPermission = typeof userPermissions.$inferSelect;
export type UserRole = (typeof USER_ROLES)[number];
export type PermissionModule = (typeof PERMISSION_MODULES)[number];
