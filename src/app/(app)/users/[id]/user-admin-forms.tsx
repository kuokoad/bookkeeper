'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  resetPasswordAction,
  setPinAction,
  setUserActiveAction,
  setUserPermissionsAction,
  unlockUserAction,
  updateUserAction,
} from '@/actions/user.actions';
import type { FormState } from '@/actions/auth.actions';
import type { PermissionModule, UserRole } from '@/db/schema/users';
import type { ModulePermission } from '@/lib/auth/permissions';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field, TextInput } from '@/components/ui/field';
import { PermissionMatrix } from '@/components/shared/permission-matrix';

function Submit({ label, variant = 'primary' }: { label: string; variant?: 'primary' | 'danger' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

export function UserAdminForms({
  userId,
  username,
  displayName,
  role,
  isActive,
  isLocked,
  hasPin,
  isSelf,
  permissions,
}: {
  userId: number;
  username: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  isLocked: boolean;
  hasPin: boolean;
  isSelf: boolean;
  permissions: Partial<Record<PermissionModule, ModulePermission>>;
}) {
  const [detailsState, detailsAction] = useActionState<FormState, FormData>(
    updateUserAction.bind(null, userId),
    {},
  );
  const [permissionState, permissionAction] = useActionState<FormState, FormData>(
    setUserPermissionsAction.bind(null, userId),
    {},
  );
  const [passwordState, passwordAction] = useActionState<FormState, FormData>(
    resetPasswordAction.bind(null, userId),
    {},
  );
  const [pinState, pinAction] = useActionState<FormState, FormData>(
    setPinAction.bind(null, userId),
    {},
  );

  const [selectedRole, setSelectedRole] = useState<UserRole>(role);
  const [confirmingOff, setConfirmingOff] = useState(false);

  return (
    <div className="space-y-6">
      <form action={detailsAction} className="rounded-xl border border-line bg-surface-raised p-4" noValidate>
        <h2 className="mb-3 text-sm font-semibold text-content">Details</h2>
        {detailsState.error && (
          <Alert tone="danger" className="mb-3">
            {detailsState.error}
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Their name"
            htmlFor="displayName"
            required
            error={detailsState.fieldErrors?.['displayName']}
          >
            <TextInput id="displayName" name="displayName" defaultValue={displayName} required />
          </Field>

          <Field label="Role" htmlFor="role" required>
            <select
              id="role"
              name="role"
              value={selectedRole}
              onChange={(event) => setSelectedRole(event.target.value as UserRole)}
              className="h-11 w-full rounded-lg border border-line-strong bg-surface-raised px-3 text-content"
            >
              <option value="STAFF">Staff</option>
              <option value="OWNER">Owner</option>
            </select>
          </Field>
        </div>

        <p className="mt-2 text-xs text-content-subtle">
          Username <strong className="text-content">{username}</strong> cannot be changed — it is
          referenced throughout the audit trail.
        </p>

        {selectedRole !== role && (
          <Alert tone="warning" className="mt-3">
            {selectedRole === 'OWNER'
              ? 'Making this person an owner gives them full access to everything, including money and other accounts. Their individual permissions will be removed.'
              : 'Dropping this person to staff removes their full access. Tick what they should still be able to do below.'}{' '}
            They will be signed out.
          </Alert>
        )}

        <div className="mt-4">
          <Submit label="Save details" />
        </div>
      </form>

      {selectedRole === 'STAFF' && role === 'STAFF' && (
        <form
          action={permissionAction}
          className="rounded-xl border border-line bg-surface-raised p-4"
          noValidate
        >
          <h2 className="mb-1 text-sm font-semibold text-content">What they can do</h2>
          <p className="mb-4 text-sm text-content-muted">
            Saving this signs them out, so the change takes effect immediately.
          </p>
          {permissionState.error && (
            <Alert tone="danger" className="mb-3">
              {permissionState.error}
            </Alert>
          )}
          <PermissionMatrix initial={permissions} />
          <div className="mt-4">
            <Submit label="Save permissions" />
          </div>
        </form>
      )}

      {role === 'OWNER' && (
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <h2 className="mb-1 text-sm font-semibold text-content">What they can do</h2>
          <p className="text-sm text-content-muted">
            An owner has full access to everything. There is nothing to limit.
          </p>
        </div>
      )}

      <form action={passwordAction} className="rounded-xl border border-line bg-surface-raised p-4" noValidate>
        <h2 className="mb-1 text-sm font-semibold text-content">Reset their password</h2>
        <p className="mb-3 text-sm text-content-muted">
          Use this when someone has forgotten theirs. They are signed out and must choose a new
          password the next time they sign in, so you do not keep knowing a working password for
          their account.
        </p>
        {passwordState.error && (
          <Alert tone="danger" className="mb-3">
            {passwordState.error}
          </Alert>
        )}
        <div className="max-w-sm">
          <Field
            label="New starting password"
            htmlFor="password"
            required
            error={passwordState.fieldErrors?.['password']}
          >
            <TextInput
              id="password"
              name="password"
              type="text"
              autoComplete="off"
              required
              invalid={Boolean(passwordState.fieldErrors?.['password'])}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Submit label="Reset password" />
        </div>
      </form>

      <form action={pinAction} className="rounded-xl border border-line bg-surface-raised p-4" noValidate>
        <h2 className="mb-1 text-sm font-semibold text-content">Till PIN</h2>
        <p className="mb-3 text-sm text-content-muted">
          A short PIN for switching quickly at the till. {hasPin ? 'A PIN is currently set. ' : ''}
          Leave it blank to remove it. Wrong PINs lock the account just as wrong passwords do.
        </p>
        {pinState.error && (
          <Alert tone="danger" className="mb-3">
            {pinState.error}
          </Alert>
        )}
        <div className="max-w-xs">
          <Field label="PIN (4–8 digits)" htmlFor="pin" error={pinState.fieldErrors?.['pin']}>
            <TextInput
              id="pin"
              name="pin"
              inputMode="numeric"
              autoComplete="off"
              placeholder={hasPin ? 'Enter a new PIN, or leave blank to remove' : 'e.g. 8351'}
              invalid={Boolean(pinState.fieldErrors?.['pin'])}
            />
          </Field>
        </div>
        <div className="mt-4">
          <Submit label="Save PIN" />
        </div>
      </form>

      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <h2 className="mb-3 text-sm font-semibold text-content">Access</h2>
        <div className="flex flex-wrap items-center gap-3">
          {isLocked && (
            <form action={unlockUserAction.bind(null, userId)}>
              <Button type="submit" variant="secondary">
                Unlock the account
              </Button>
            </form>
          )}

          {isActive ? (
            isSelf ? (
              <p className="text-sm text-content-muted">
                You cannot switch off your own account.
              </p>
            ) : confirmingOff ? (
              <form
                action={setUserActiveAction.bind(null, userId, false)}
                className="flex items-center gap-3"
              >
                <span className="text-sm text-content">
                  Switch off {displayName}? They will be signed out immediately.
                </span>
                <Button type="submit" variant="danger">
                  Yes, switch off
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmingOff(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button type="button" variant="secondary" onClick={() => setConfirmingOff(true)}>
                Switch off this account…
              </Button>
            )
          ) : (
            <form action={setUserActiveAction.bind(null, userId, true)}>
              <Button type="submit">Turn the account back on</Button>
            </form>
          )}
        </div>
        <p className="mt-3 text-xs text-content-subtle">
          Accounts are never deleted. Everything this person recorded stays in the books and in the
          audit trail.
        </p>
      </div>
    </div>
  );
}
