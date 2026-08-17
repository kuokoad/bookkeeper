import { and, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import { auditLogs, type AuditAction } from '@/db/schema';

/**
 * The audit trail.
 *
 * Insert-only by design: this module exposes no update or delete function, and
 * no other module writes to `audit_logs` directly. Removing a record of what
 * happened is not an operation the application supports.
 */

export interface AuditEntryInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | number | null;
  summary: string;
  userId?: number | null;
  username?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  at?: Date;
}

/** Keys whose values must never reach the audit log. */
const REDACTED_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'confirmpassword',
  'pin',
  'passwordhash',
  'pinhash',
  'token',
  'sessiontoken',
  'secret',
]);

/**
 * Strip credentials before serialising. The audit log records that a password
 * was changed, never what it was changed to.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))
      ? '[redacted]'
      : redact(item, depth + 1);
  }
  return output;
}

/**
 * Write one audit record.
 *
 * Takes a `Tx` so it joins the caller's transaction: if the business operation
 * rolls back, so does its audit entry, and the log never claims something
 * happened that did not.
 */
export function writeAudit(tx: Tx, entry: AuditEntryInput): void {
  tx.insert(auditLogs)
    .values({
      userId: entry.userId ?? null,
      username: entry.username ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId === null || entry.entityId === undefined ? null : String(entry.entityId),
      summary: entry.summary,
      metadata: entry.metadata ? JSON.stringify(redact(entry.metadata)) : null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      createdAt: entry.at ?? new Date(),
    })
    .run();
}

export interface AuditQuery {
  userId?: number;
  action?: AuditAction;
  entityType?: string;
  entityId?: string;
  /** Free text across the summary and username. */
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/** Total matching rows, so the browser can paginate honestly. */
export function countAuditLogs(db: Db, query: AuditQuery = {}): number {
  const conditions = auditConditions(query);
  const base = db.select({ count: sql<number>`COUNT(*)` }).from(auditLogs);
  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();
  return row?.count ?? 0;
}

/** The distinct entity types present, for the filter dropdown. */
export function listAuditEntityTypes(db: Db): string[] {
  return db
    .selectDistinct({ entityType: auditLogs.entityType })
    .from(auditLogs)
    .orderBy(auditLogs.entityType)
    .all()
    .map((row) => row.entityType);
}

function auditConditions(query: AuditQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.userId !== undefined) conditions.push(eq(auditLogs.userId, query.userId));
  if (query.action !== undefined) conditions.push(eq(auditLogs.action, query.action));
  if (query.entityType !== undefined) conditions.push(eq(auditLogs.entityType, query.entityType));
  if (query.entityId !== undefined) conditions.push(eq(auditLogs.entityId, query.entityId));
  if (query.from !== undefined) conditions.push(gte(auditLogs.createdAt, query.from));
  if (query.to !== undefined) conditions.push(lte(auditLogs.createdAt, query.to));

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${auditLogs.summary}) LIKE ${term}`,
      sql`lower(COALESCE(${auditLogs.username}, '')) LIKE ${term}`,
    );
    if (match) conditions.push(match);
  }

  return conditions;
}

export function listAuditLogs(db: Db, query: AuditQuery = {}) {
  const conditions = auditConditions(query);
  const base = db.select().from(auditLogs);
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;

  return filtered
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(Math.min(query.limit ?? 50, 500))
    .offset(query.offset ?? 0)
    .all();
}
