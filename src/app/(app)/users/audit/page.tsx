import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  countAuditLogs,
  listAuditEntityTypes,
  listAuditLogs,
  type AuditQuery,
} from '@/services/audit.service';
import { listUsers } from '@/services/user.service';
import { AUDIT_ACTIONS, type AuditAction } from '@/db/schema/system';
import { formatDateTime, fromBusinessDate, isValidBusinessDate, toBusinessDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { DateField } from '@/components/ui/date-field';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const ACTION_TONES: Record<string, 'success' | 'warning' | 'danger' | 'accent' | 'neutral'> = {
  LOGIN_SUCCESS: 'success',
  LOGIN_FAILED: 'danger',
  LOGOUT: 'neutral',
  CREATE: 'success',
  UPDATE: 'accent',
  ARCHIVE: 'warning',
  RESTORE: 'success',
  VOID: 'danger',
  REVERSE: 'danger',
  RECONCILE: 'accent',
  PERMISSION_CHANGE: 'warning',
  PASSWORD_CHANGE: 'warning',
  SETTINGS_CHANGE: 'warning',
  SEED_DEMO: 'neutral',
  PURGE_DEMO: 'neutral',
};

const ACTION_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: 'Signed in',
  LOGIN_FAILED: 'Failed sign-in',
  LOGOUT: 'Signed out',
  CREATE: 'Created',
  UPDATE: 'Changed',
  ARCHIVE: 'Archived',
  RESTORE: 'Restored',
  VOID: 'Voided',
  REVERSE: 'Reversed',
  RECONCILE: 'Counted',
  PERMISSION_CHANGE: 'Permissions',
  PASSWORD_CHANGE: 'Password',
  SETTINGS_CHANGE: 'Settings',
  SEED_DEMO: 'Demo data',
  PURGE_DEMO: 'Demo purge',
};

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    user?: string;
    action?: string;
    entity?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  // The audit log records who did what with the shop's money, so it sits
  // behind the same permission as managing people.
  await requirePageAccess('users', 'view');
  const params = await searchParams;

  const page = Math.max(1, Number(params.page ?? '1') || 1);
  const userId = params.user ? Number(params.user) : undefined;
  const action = AUDIT_ACTIONS.includes(params.action as AuditAction)
    ? (params.action as AuditAction)
    : undefined;

  const query: AuditQuery = {
    ...(Number.isInteger(userId) && userId! > 0 ? { userId } : {}),
    ...(action ? { action } : {}),
    ...(params.entity ? { entityType: params.entity } : {}),
    ...(params.q ? { search: params.q } : {}),
    ...(params.from && isValidBusinessDate(params.from)
      ? { from: fromBusinessDate(params.from) }
      : {}),
    ...(params.to && isValidBusinessDate(params.to)
      ? // Include the whole of the "to" day, not just its first instant.
        { to: new Date(fromBusinessDate(params.to).getTime() + 86_399_999) }
      : {}),
  };

  const total = countAuditLogs(db, query);
  const entries = listAuditLogs(db, {
    ...query,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const users = listUsers(db);
  const entityTypes = listAuditEntityTypes(db);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const queryString = (overrides: Record<string, string | undefined>): string => {
    const next = new URLSearchParams();
    const merged = {
      user: params.user,
      action: params.action,
      entity: params.entity,
      q: params.q,
      from: params.from,
      to: params.to,
      page: params.page,
      ...overrides,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== '') next.set(key, value);
    }
    return next.toString();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Audit log"
        description="Everything that has happened, who did it, and when."
        actions={
          <Link href="/users">
            <Button variant="secondary" size="sm">
              Users
            </Button>
          </Link>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Records found" value={String(total)} />
        <Stat label="Showing" value={`${entries.length} of ${total}`} hint={`Page ${page} of ${totalPages}`} />
        <Stat label="People" value={String(users.length)} />
      </div>

      <form action="/users/audit" className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="q" className="mb-1 block text-xs text-content-muted">
            Search
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={params.q ?? ''}
            placeholder="What happened, or who"
            className="h-10 w-52 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <div>
          <label htmlFor="user" className="mb-1 block text-xs text-content-muted">
            Person
          </label>
          <select
            id="user"
            name="user"
            defaultValue={params.user ?? ''}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          >
            <option value="">Anyone</option>
            {users.map((user) => (
              <option key={user.id} value={String(user.id)}>
                {user.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="action" className="mb-1 block text-xs text-content-muted">
            Action
          </label>
          <select
            id="action"
            name="action"
            defaultValue={params.action ?? ''}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          >
            <option value="">Anything</option>
            {AUDIT_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {ACTION_LABELS[value] ?? value}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="entity" className="mb-1 block text-xs text-content-muted">
            Kind of record
          </label>
          <select
            id="entity"
            name="entity"
            defaultValue={params.entity ?? ''}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          >
            <option value="">Anything</option>
            {entityTypes.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-content-muted">
            From
          </label>
          <DateField
            id="from"
            name="from"
            defaultValue={params.from ?? ''}
            max={toBusinessDate()}
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-content-muted">
            To
          </label>
          <DateField
            id="to"
            name="to"
            defaultValue={params.to ?? ''}
            max={toBusinessDate()}
          />
        </div>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
        <Link href="/users/audit">
          <Button type="button" size="sm" variant="ghost">
            Clear
          </Button>
        </Link>
      </form>

      {entries.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try widening the dates, or clearing the filters."
        />
      ) : (
        <>
          <TableWrap>
            <THead>
              <TH>When</TH>
              <TH>Who</TH>
              <TH>Action</TH>
              <TH>What happened</TH>
              <TH>Record</TH>
            </THead>
            <tbody>
              {entries.map((entry) => (
                <TR key={entry.id}>
                  <TD>
                    <span className="whitespace-nowrap text-content-muted">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-content">{entry.username ?? 'System'}</span>
                  </TD>
                  <TD>
                    <Badge tone={ACTION_TONES[entry.action] ?? 'neutral'}>
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </Badge>
                  </TD>
                  <TD>{entry.summary}</TD>
                  <TD>
                    <span className="text-xs text-content-subtle">
                      {entry.entityType.replace(/_/g, ' ')}
                      {entry.entityId ? ` #${entry.entityId}` : ''}
                    </span>
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-sm text-content-muted">
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link href={`/users/audit?${queryString({ page: String(page - 1) })}`}>
                    <Button size="sm" variant="secondary">
                      Previous
                    </Button>
                  </Link>
                )}
                {page < totalPages && (
                  <Link href={`/users/audit?${queryString({ page: String(page + 1) })}`}>
                    <Button size="sm" variant="secondary">
                      Next
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Nothing here can be edited or removed — there is no code path in the application that
        changes or deletes an audit record. Passwords and PINs are never written to it.
      </p>
    </div>
  );
}
