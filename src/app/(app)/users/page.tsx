import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { listUsers } from '@/services/user.service';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const actor = await requirePageAccess('users', 'view');
  const users = listUsers(db);

  const owners = users.filter((user) => user.role === 'OWNER' && user.isActive);
  const locked = users.filter((user) => user.isLocked);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Users"
        description="Who can sign in, and what each person is allowed to do."
        actions={
          can(actor, 'users', 'create') ? (
            <Link href="/users/new">
              <Button size="sm">Add a user</Button>
            </Link>
          ) : null
        }
      />

      {locked.length > 0 && (
        <Alert tone="warning" title="Someone is locked out" className="mb-4">
          {locked.map((user) => user.displayName).join(', ')} entered the wrong password too many
          times. Open their account to unlock it.
        </Alert>
      )}

      {owners.length === 1 && (
        <Alert tone="info" className="mb-4">
          There is only one owner account. If you lose access to it, nobody can manage the shop —
          consider making a second person an owner.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="People" value={String(users.filter((user) => user.isActive).length)} />
        <Stat label="Owners" value={String(owners.length)} />
        <Stat
          label="Switched off"
          value={String(users.filter((user) => !user.isActive).length)}
        />
      </div>

      <TableWrap>
        <THead>
          <TH>Person</TH>
          <TH>Role</TH>
          <TH numeric>Areas</TH>
          <TH>Last signed in</TH>
          <TH>Status</TH>
          <TH />
        </THead>
        <tbody>
          {users.map((user) => {
            const isLocked = user.isLocked;
            return (
              <TR key={user.id}>
                <TD>
                  <Link
                    href={`/users/${user.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {user.displayName}
                  </Link>
                  {user.id === actor.id && (
                    <Badge tone="accent" className="ml-2">
                      You
                    </Badge>
                  )}
                  <span className="mt-0.5 block text-xs text-content-subtle">
                    {user.username}
                    {user.hasPin && ' · has a till PIN'}
                  </span>
                </TD>
                <TD>
                  <Badge tone={user.role === 'OWNER' ? 'accent' : 'neutral'}>
                    {user.role === 'OWNER' ? 'Owner' : 'Staff'}
                  </Badge>
                </TD>
                <TD numeric>
                  {user.role === 'OWNER' ? (
                    <span className="text-content-subtle">All</span>
                  ) : (
                    user.moduleCount
                  )}
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {user.lastLoginAt === null ? 'Never' : formatDateTime(user.lastLoginAt)}
                  </span>
                </TD>
                <TD>
                  {!user.isActive ? (
                    <Badge tone="neutral">Switched off</Badge>
                  ) : isLocked ? (
                    <Badge tone="danger">Locked</Badge>
                  ) : user.mustChangePassword ? (
                    <Badge tone="warning">Must set password</Badge>
                  ) : (
                    <Badge tone="success">Active</Badge>
                  )}
                </TD>
                <TD>
                  <div className="flex justify-end">
                    <Link
                      href={`/users/${user.id}`}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      Manage
                    </Link>
                  </div>
                </TD>
              </TR>
            );
          })}
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        Accounts are switched off, never deleted — their sales, counts and audit history must
        survive. Switching someone off ends their session immediately.
      </p>
    </div>
  );
}
