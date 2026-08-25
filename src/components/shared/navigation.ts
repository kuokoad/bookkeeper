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
  /**
   * The module this item requires, or omitted for a page any signed-in user may
   * open. Only the dashboard is in the second group, and it has to be: every
   * sign-in lands there, so a menu that could hide it would hide the page the
   * person is standing on.
   */
  module?: PermissionModule;
  /** Shown in the mobile bottom bar (space for five). */
  primary?: boolean;
  /** Not yet built — rendered disabled with a "Soon" tag rather than as a dead link. */
  comingSoon?: boolean;
}

export interface NavSection {
  heading: string;
  items: NavItem[];
  /**
   * Expanded on arrival regardless of which page you are on.
   *
   * The two sections used all day stay open so the till and the stock list are
   * always one click away; the rest fold until needed.
   */
  defaultOpen?: boolean;
}

/**
 * The menu.
 *
 * Three pages that were here are deliberately not: Other Income sits beside
 * Expenses, Reconciliation under Accounting, and the Audit log on the Users
 * page. Each is opened occasionally rather than daily, and each is now one
 * click from the screen it belongs to — a menu long enough to scroll is a menu
 * nobody reads to the bottom of.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    heading: 'Daily',
    defaultOpen: true,
    items: [
      // No module: the dashboard asks only for a signed-in user, exactly as the
      // page itself does. It used to require `reports`, which hid it from every
      // staff account — while `loginAction` went on sending them straight to it.
      { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', primary: true },
      { href: '/sales', label: 'Sales', icon: 'sales', module: 'sales', primary: true },
      { href: '/purchases', label: 'Purchases', icon: 'purchases', module: 'purchases' },
      { href: '/expenses', label: 'Expenses', icon: 'expenses', module: 'expenses', primary: true },
    ],
  },
  {
    heading: 'Stock',
    defaultOpen: true,
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
      { href: '/accounting', label: 'Accounting', icon: 'reports', module: 'accounts' },
      { href: '/reports', label: 'Reports', icon: 'reports', module: 'reports' },
    ],
  },
  {
    heading: 'Admin',
    items: [
      { href: '/users', label: 'Users', icon: 'users', module: 'users' },
      { href: '/settings', label: 'Settings', icon: 'settings', module: 'settings' },
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
