import type { PermissionModule } from '@/db/schema/users';
import type { FeatureKey } from '@/lib/business-type';
import type { IconName as DrawnIcon } from '@/components/ui/icon';

/**
 * Navigation definition.
 *
 * Each item names the module it requires, so the sidebar is filtered by the
 * same `can()` function the server actions use. Hiding a link is a convenience;
 * the server check is what actually protects the route.
 */

/**
 * The icons a MENU entry may use — deliberately narrower than the drawn set.
 * `icon: 'profit'` should not typecheck here: there is no page called Profit
 * to put it on, and the card vocabulary is not a list of destinations.
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
  | 'quotations'
  | 'users'
  | 'settings'
  | 'search'
  | 'help';

/**
 * Every name above must actually be drawn. Renaming a path in `ui/icon.tsx`
 * without renaming it here would otherwise reach the shop as a menu of blank
 * squares — the icon component looks the name up and gets `undefined`.
 */
type NavIconsAreDrawn = IconName extends DrawnIcon ? true : never;
const _navIconsAreDrawn: NavIconsAreDrawn = true;
void _navIconsAreDrawn;

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
  /**
   * The feature this item belongs to, or omitted for one every shop is offered.
   *
   * NOT a permission, and it protects nothing: the page behind a hidden item
   * opens normally if its address is typed, which is what keeps a record
   * reachable after a shop changes what kind of shop it is. It only stops a
   * building materials yard being offered a screen about expiry dates.
   *
   * `tests/app/page-guards.test.ts` parses this file with a regex that stops at
   * the first `}`, so an item carrying this key must stay on ONE line and the
   * value must be a bare quoted string — never an object, array or template.
   */
  feature?: FeatureKey;
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
      { href: '/quotations', label: 'Quotations', icon: 'quotations', module: 'quotations', feature: 'quotations' },
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
  {
    // The shop-owner guides, by name. A single "Help" item under a "Help"
    // heading said the word twice and the page it opened was only a list of
    // these; this is the same click count with the destination on it.
    //
    // No `defaultOpen`, so the section is a single folded row until you are
    // inside it — six titles is the right thing to find when you go looking for
    // help, and the wrong thing to scroll past every day on the way to Sales.
    //
    // No module on either, like the dashboard: the person who most needs
    // telling how the till works is the one holding the fewest permissions.
    // These must stay in step with `HELP_PAGES` in src/lib/help.ts — that file
    // reads the filesystem, so it cannot be imported here, and a test holds the
    // two lists together instead.
    heading: 'Help',
    items: [
      { href: '/help/getting-started', label: 'Getting started', icon: 'help' },
      { href: '/help/finding-things', label: 'Finding things', icon: 'help' },
      { href: '/help/quoting', label: 'Quoting a customer', icon: 'help' },
      { href: '/help/fixing-a-mistake', label: 'Fixing a mistake', icon: 'help' },
      { href: '/help/managing-tax', label: 'Managing tax', icon: 'help' },
      { href: '/help/closing-a-period', label: 'Closing a period', icon: 'help' },
      { href: '/help/backups', label: 'Backups', icon: 'help' },
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
