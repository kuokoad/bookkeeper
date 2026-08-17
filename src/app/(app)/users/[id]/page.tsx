import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getUser, getUserPermissions } from '@/services/user.service';
import { listAuditLogs } from '@/services/audit.service';
import { formatDateTime } from '@/lib/format';
import { isDomainError } from '@/domain/errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { UserAdminForms } from './user-admin-forms';

export const metadata: Metadata = { title: 'User' };
export const dynamic = 'force-dynamic';

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    created?: string;
    updated?: string;
    permissions?: string;
    reset?: string;
    pin?: string;
  }>;
}) {
  const actor = await requirePageAccess('users', 'view');
  const { id } = await params;
  const query = await searchParams;

  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) notFound();

  let user;
  try {
    user = getUser(db, userId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const permissions = getUserPermissions(db, userId);
  const activity = listAuditLogs(db, { userId, limit: 25 });
  const isLocked = user.isLocked;
  const canEdit = can(actor, 'users', 'edit');

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={user.displayName}
        description={`${user.username} · ${user.role === 'OWNER' ? 'Owner' : 'Staff'}`}
        actions={
          <Link href="/users">
            <Button variant="secondary" size="sm">
              All users
            </Button>
          </Link>
        }
      />

      {query.created === '1' && (
        <Alert tone="success" className="mb-4">
          Account created. Give them the starting password — they will be asked to choose their own
          the first time they sign in.
        </Alert>
      )}
      {query.updated === '1' && <Alert tone="success" className="mb-4">Account updated.</Alert>}
      {query.permissions === '1' && (
        <Alert tone="success" className="mb-4">
          Permissions saved. They were signed out, so the new rights apply as soon as they sign back
          in.
        </Alert>
      )}
      {query.reset === '1' && (
        <Alert tone="success" className="mb-4">
          Password reset. They were signed out and must choose a new password next time.
        </Alert>
      )}
      {query.pin === '1' && <Alert tone="success" className="mb-4">Till PIN updated.</Alert>}

      {isLocked && (
        <Alert tone="warning" title="This account is locked" className="mb-4">
          Too many wrong passwords. It unlocks by itself at{' '}
          {formatDateTime(user.lockedUntil as Date)}, or you can unlock it now below.
        </Alert>
      )}

      {!user.isActive && (
        <Alert tone="warning" title="This account is switched off" className="mb-4">
          They cannot sign in. Their records and history are kept.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-content-muted">Last signed in</p>
          <p className="mt-1 font-medium text-content">
            {user.lastLoginAt === null ? 'Never' : formatDateTime(user.lastLoginAt)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Till PIN</p>
          <p className="mt-1 font-medium text-content">{user.hasPin ? 'Set' : 'Not set'}</p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Status</p>
          <p className="mt-1">
            {!user.isActive ? (
              <Badge tone="neutral">Switched off</Badge>
            ) : isLocked ? (
              <Badge tone="danger">Locked</Badge>
            ) : user.mustChangePassword ? (
              <Badge tone="warning">Must set password</Badge>
            ) : (
              <Badge tone="success">Active</Badge>
            )}
          </p>
        </Card>
      </div>

      {canEdit ? (
        <UserAdminForms
          userId={user.id}
          username={user.username}
          displayName={user.displayName}
          role={user.role}
          isActive={user.isActive}
          isLocked={isLocked}
          hasPin={user.hasPin}
          isSelf={user.id === actor.id}
          permissions={permissions}
        />
      ) : (
        <Card>
          <p className="text-sm text-content-muted">
            You can see this account but not change it.
          </p>
        </Card>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-content">Recent activity</h2>
      {activity.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">Nothing recorded for this person yet.</p>
        </Card>
      ) : (
        <TableWrap>
          <THead>
            <TH>When</TH>
            <TH>What</TH>
          </THead>
          <tbody>
            {activity.map((entry) => (
              <TR key={entry.id}>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </TD>
                <TD>{entry.summary}</TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}

      <p className="mt-3 text-xs text-content-subtle">
        <Link href={`/users/audit?user=${user.id}`} className="text-accent hover:underline">
          See everything this person has done
        </Link>
      </p>
    </div>
  );
}
