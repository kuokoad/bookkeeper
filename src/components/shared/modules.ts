import type { PermissionModule } from '@/db/schema/users';

export interface ModuleRow {
  module: PermissionModule;
  label: string;
  description: string;
}

/**
 * Plain-language names, because "module" means nothing to a shop owner.
 *
 * Kept out of the permission matrix component so server-rendered pages can use
 * the same wording without pulling a client component in behind it.
 */
export const MODULE_ROWS: readonly ModuleRow[] = [
  { module: 'sales', label: 'Sales', description: 'Use the till and see past sales' },
  { module: 'purchases', label: 'Purchases', description: 'Record deliveries from suppliers' },
  { module: 'products', label: 'Products', description: 'The list of what you sell, and prices' },
  { module: 'inventory', label: 'Inventory', description: 'Stock levels and adjustments' },
  { module: 'customers', label: 'Customers', description: 'Customer records and their debts' },
  { module: 'suppliers', label: 'Suppliers', description: 'Supplier records and what you owe' },
  { module: 'expenses', label: 'Expenses', description: 'Money spent running the shop' },
  { module: 'income', label: 'Other income', description: 'Money in that is not a sale' },
  { module: 'accounts', label: 'Accounts', description: 'Cash, MoMo and bank balances' },
  {
    module: 'reconciliation',
    label: 'Reconciliation',
    description: 'Counting cash against the books',
  },
  {
    module: 'quotations',
    label: 'Quotations',
    description: 'Prepare priced quotes for customers',
  },
  { module: 'reports', label: 'Reports', description: 'Profit, balance sheet and the dashboard' },
  { module: 'users', label: 'Users', description: 'Staff accounts and what they can do' },
  { module: 'settings', label: 'Settings', description: 'Shop settings and closing the books' },
];

/** The shop-owner's word for an area, or null if the name is not one of ours. */
export function moduleLabel(module: string): string | null {
  return MODULE_ROWS.find((row) => row.module === module)?.label ?? null;
}
