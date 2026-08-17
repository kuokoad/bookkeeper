import type { PermissionModule, UserRole } from '@/db/schema/users';
import { PERMISSION_MODULES } from '@/db/schema/users';

export const PERMISSION_ACTIONS = ['view', 'create', 'edit', 'void'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Flags for one module. */
export interface ModulePermission {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canVoid: boolean;
}

export type PermissionMap = Partial<Record<PermissionModule, ModulePermission>>;

export interface Principal {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  permissions: PermissionMap;
}

export const NO_ACCESS: ModulePermission = {
  canView: false,
  canCreate: false,
  canEdit: false,
  canVoid: false,
};

export const FULL_ACCESS: ModulePermission = {
  canView: true,
  canCreate: true,
  canEdit: true,
  canVoid: true,
};

function flagFor(permission: ModulePermission, action: PermissionAction): boolean {
  switch (action) {
    case 'view':
      return permission.canView;
    case 'create':
      return permission.canCreate;
    case 'edit':
      return permission.canEdit;
    case 'void':
      return permission.canVoid;
  }
}

/**
 * The single authority on "may this user do this?".
 *
 * Called on the server for every mutating action. The UI also calls it to hide
 * controls, but hiding a button is a courtesy — the server check is the actual
 * protection, and it never trusts anything sent by the browser.
 */
export function can(
  principal: Pick<Principal, 'role' | 'permissions'>,
  module: PermissionModule,
  action: PermissionAction,
): boolean {
  // The owner is not subject to the permission table.
  if (principal.role === 'OWNER') return true;

  const permission = principal.permissions[module];
  if (!permission) return false;

  // Creating, editing or voiding all imply being able to see the module;
  // a staff member who cannot view sales cannot record one either.
  if (action !== 'view' && !permission.canView) return false;

  return flagFor(permission, action);
}

export function permissionsFor(
  principal: Pick<Principal, 'role' | 'permissions'>,
  module: PermissionModule,
): ModulePermission {
  if (principal.role === 'OWNER') return FULL_ACCESS;
  return principal.permissions[module] ?? NO_ACCESS;
}

/** Modules the user may open at all — drives which nav links are rendered. */
export function visibleModules(
  principal: Pick<Principal, 'role' | 'permissions'>,
): PermissionModule[] {
  return PERMISSION_MODULES.filter((module) => can(principal, module, 'view'));
}

/**
 * Sensible starting permissions for a new shop assistant: run the till, look up
 * stock, but no access to money movement, reports, users or settings.
 */
export function defaultStaffPermissions(): PermissionMap {
  return {
    sales: { canView: true, canCreate: true, canEdit: false, canVoid: false },
    products: { canView: true, canCreate: false, canEdit: false, canVoid: false },
    inventory: { canView: true, canCreate: false, canEdit: false, canVoid: false },
    customers: { canView: true, canCreate: true, canEdit: false, canVoid: false },
  };
}
