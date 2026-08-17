import type { PermissionModule } from '@/db/schema/users';

/**
 * Navigation definition.
 *
 * Each item names the module it requires, so the sidebar is filtered by the
 * same `can()` function the server actions use. Hiding a link is a convenience;
 * the server check is what actually protects the route.
 */

export type IconName =
  | 'dashboard'
  | 'sales'
  | 'purchases'
  | 'products'
  | 'inventory'
  | 'customers'
  | 'suppliers'
  | 'expenses'
  | 'income'
  | 'accounts'
  | 'reports'
  | 'users'
  | 'settings';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  module: PermissionModule;
  /** Shown in the mobile bottom bar (space for five). */
  primary?: boolean;
  /** Not yet built — rendered disabled with a "Soon" tag rather than as a dead link. */
  comingSoon?: boolean;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    heading: 'Daily',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', module: 'reports', primary: true },
      { href: '/sales', label: 'Sales', icon: 'sales', module: 'sales', primary: true },
      { href: '/purchases', label: 'Purchases', icon: 'purchases', module: 'purchases' },
      { href: '/expenses', label: 'Expenses', icon: 'expenses', module: 'expenses', primary: true },
      { href: '/income', label: 'Other Income', icon: 'income', module: 'income' },
    ],
  },
  {
    heading: 'Stock',
    items: [
      { href: '/products', label: 'Products', icon: 'products', module: 'products', primary: true },
      { href: '/inventory', label: 'Inventory', icon: 'inventory', module: 'inventory' },
    ],
  },
  {
    heading: 'People',
    items: [
      { href: '/customers', label: 'Customers', icon: 'customers', module: 'customers' },
      { href: '/suppliers', label: 'Suppliers', icon: 'suppliers', module: 'suppliers' },
    ],
  },
  {
    heading: 'Money',
    items: [
      { href: '/accounts', label: 'Accounts', icon: 'accounts', module: 'accounts' },
      {
        href: '/reconciliation',
        label: 'Reconciliation',
        icon: 'accounts',
        module: 'reconciliation',
      },
      { href: '/accounting', label: 'Accounting', icon: 'reports', module: 'accounts' },
      { href: '/reports', label: 'Reports', icon: 'reports', module: 'reports' },
    ],
  },
  {
    heading: 'Admin',
    items: [
      { href: '/users', label: 'Users', icon: 'users', module: 'users' },
      { href: '/users/audit', label: 'Audit log', icon: 'reports', module: 'users' },
      { href: '/settings', label: 'Settings', icon: 'settings', module: 'settings', comingSoon: true },
    ],
  },
];

/** Quick actions surfaced prominently — the things done many times a day. */
export interface QuickAction {
  href: string;
  label: string;
  icon: IconName;
  module: PermissionModule;
  comingSoon?: boolean;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { href: '/sales/new', label: 'New Sale', icon: 'sales', module: 'sales' },
  { href: '/purchases/new', label: 'New Purchase', icon: 'purchases', module: 'purchases' },
  { href: '/suppliers', label: 'Pay Supplier', icon: 'suppliers', module: 'suppliers' },
  { href: '/expenses', label: 'Add Expense', icon: 'expenses', module: 'expenses' },
  { href: '/products/new', label: 'Add Product', icon: 'products', module: 'products' },
  {
    href: '/inventory/adjustments/new',
    label: 'Stock Adjustment',
    icon: 'inventory',
    module: 'inventory',
  },
];
