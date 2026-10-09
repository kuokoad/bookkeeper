/** Locally hosted Material Symbols, using the existing typed icon vocabulary. */

/**
 * The vocabulary. Icons say what KIND of thing a figure is — money out, owed
 * to you, stock, people — so two cards showing the same kind carry the same
 * mark. That repetition is the vocabulary working; a unique glyph per label
 * would mean inventing pictures for things like "Average expense".
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
  | 'help'
  | 'cashflow'
  | 'profit'
  | 'owed'
  | 'owes'
  | 'discount'
  | 'warning'
  | 'check'
  | 'books'
  | 'add'
  | 'receipt'
  | 'shoppingBag'
  | 'payment'
  | 'bank'
  | 'stock'
  | 'notifications';

const SYMBOLS: Record<IconName, string> = {
  dashboard: 'space_dashboard', sales: 'shopping_cart', purchases: 'receipt_long',
  products: 'inventory_2', inventory: 'warehouse', customers: 'group',
  suppliers: 'local_shipping', expenses: 'payments', income: 'add_task',
  accounts: 'account_balance_wallet', reports: 'analytics', quotations: 'request_quote',
  users: 'group', settings: 'settings', search: 'search', help: 'help',
  cashflow: 'payments', profit: 'trending_up', owed: 'assignment', owes: 'assignment',
  discount: 'sell', warning: 'warning', check: 'check_circle', books: 'balance',
  add: 'add', receipt: 'receipt', shoppingBag: 'shopping_bag', payment: 'credit_score',
  bank: 'account_balance', stock: 'inventory_2', notifications: 'notifications',
};

export interface IconProps {
  name: IconName;
  className?: string;
}

/** Decorative glyphs from the locally bundled, offline-capable Stitch icon font. */
export function Icon({ name, className = 'h-5 w-5' }: IconProps) {
  return <span aria-hidden="true" className={`stitch-symbol ${className}`}>{SYMBOLS[name]}</span>;
}
