/**
 * Inline SVG icon set.
 *
 * Hand-rolled rather than pulled from an icon package: it keeps the client
 * bundle small on a shop's phone over a slow connection, and there are only a
 * dozen of them.
 *
 * A primitive, and it lives here rather than in `shared/` because `Stat` needs
 * it: `shared/` may import from `ui/`, never the other way round. The union
 * below is declared here too, so nothing in this file knows the menu exists.
 * `navigation.ts` keeps its own narrower list — a menu entry should not be
 * able to choose `profit`, because there is no page by that name — and proves
 * at compile time that every icon it names is one of these.
 */

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
  | 'books';

const PATHS: Record<IconName, string> = {
  dashboard: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z',
  sales:
    'M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM2.2 3a1 1 0 0 0 0 2h1.4l2.6 9.6A2 2 0 0 0 8.1 16h9.3a2 2 0 0 0 1.9-1.4l2-6.6a1 1 0 0 0-1-1.3H6.3l-.5-1.9A1.6 1.6 0 0 0 4.3 3H2.2Z',
  purchases:
    'M6 2a1 1 0 0 0-1 1v18a1 1 0 0 0 1.5.9L12 19.2l5.5 2.7A1 1 0 0 0 19 21V3a1 1 0 0 0-1-1H6Zm2.5 5h7a1 1 0 1 1 0 2h-7a1 1 0 0 1 0-2Zm0 4h7a1 1 0 1 1 0 2h-7a1 1 0 1 1 0-2Z',
  products:
    'M12 2.3 3 6.5v11L12 21.7l9-4.2v-11L12 2.3Zm0 2.2 6.3 3L12 10.4 5.7 7.5 12 4.5ZM5 9.2l6 2.8v6.6l-6-2.8V9.2Zm8 9.4V12l6-2.8v6.6l-6 2.8Z',
  inventory:
    'M3 4h18v4H3V4Zm1 6h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10Zm5 3a1 1 0 0 0 0 2h6a1 1 0 1 0 0-2H9Z',
  customers:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.9 0-7 2-7 4.5V21h14v-3.5C16 15 12.9 13 9 13Zm8.5-1.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 13c-.7 0-1.4.1-2 .3 1.5 1.1 2.4 2.6 2.4 4.2V21H23v-3.3c0-2.4-2.3-4.7-5-4.7Z',
  suppliers:
    'M3 7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3h2.6a1 1 0 0 1 .8.4l2.4 3.2a1 1 0 0 1 .2.6V17a1 1 0 0 1-1 1h-1a3 3 0 0 0-6 0H9a3 3 0 0 0-6 0V7Zm3 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16 12v2h3.4L18 12h-2Z',
  expenses:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-1.1c-1.4-.3-2.5-1.2-2.6-2.7h1.9c.1.7.7 1.2 1.7 1.2.9 0 1.5-.4 1.5-1 0-.6-.4-.9-1.8-1.2-1.8-.4-3.1-1-3.1-2.6 0-1.4 1-2.3 2.4-2.6V6h2v1.1c1.4.3 2.3 1.2 2.4 2.5h-1.9c-.1-.6-.6-1.1-1.4-1.1-.9 0-1.4.4-1.4.9 0 .6.5.8 1.9 1.1 1.9.4 3 1.1 3 2.7 0 1.4-1 2.4-2.6 2.7V17Z',
  income:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 5v4h4v2h-4v4h-2v-4H7v-2h4V7h2Z',
  accounts:
    'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2H3V6Zm0 4h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Zm12 3a1 1 0 1 0 0 2h3a1 1 0 1 0 0-2h-3Z',
  reports:
    'M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm2 12h2v3H7v-3Zm4-6h2v9h-2V9Zm4 3h2v6h-2v-6Z',
  quotations:
    'M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H13V3.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z',
  users:
    'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.4-8 5.3V22h16v-2.7c0-2.9-3.6-5.3-8-5.3Z',
  search:
    'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10ZM14.6 16 16 14.6l5.2 5.2-1.4 1.4z',
  help:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM9 9.2a3 3 0 0 1 6 0c0 2.4-2.2 2.4-2.2 4v1.2h-1.6v-1.6c0-2.2 2.2-2 2.2-3.6a1.4 1.4 0 0 0-2.8 0Zm1.9 7h2.2v2.2h-2.2v-2.2Z',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.4 4a7.6 7.6 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L16.5 3h-4l-.4 2.6c-.7.3-1.4.7-2 1.2l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',

  /*
    The four below are drawn only for dashboard cards. Straight edges and
    circles on purpose: at 16px a clever glyph is a smudge, and these have to
    survive being the small quiet mark beside a label.
  */

  /** Money in and money out: two arrows, opposite ways. */
  cashflow: 'M3 7h11V3.6l6.5 4.9L14 13.4V10H3V7Zm18 7H10v-3.4L3.5 15.5 10 20.4V17h11v-3Z',
  /** What is left over: a line going up and to the right. */
  profit: 'M13 4h7v7h-2V7.4l-12 12-1.4-1.4 12-12H13V4Z',
  /** Owed to the shop: money still on its way in. */
  owed:
    'M11 3h2v5h2.5L12 12.5 8.5 8H11V3Zm-8 11h5l1.2 2.4a1 1 0 0 0 .9.6h3.8a1 1 0 0 0 .9-.6L16 14h5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z',
  /** Owed BY the shop: the same tray, the arrow going the other way. */
  owes:
    'M12 2.5 15.5 7H13v5.5h-2V7H8.5L12 2.5ZM3 14h5l1.2 2.4a1 1 0 0 0 .9.6h3.8a1 1 0 0 0 .9-.6L16 14h5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z',
  /** Money taken off a price. */
  discount:
    'M7.5 4.9a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Zm9 9a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2ZM16.1 3.9l1.8 1.2-10 15-1.8-1.2 10-15Z',
  /** Something wants looking at. The exclamation is a hole, not a second fill. */
  warning: 'M12 3 22.5 21H1.5L12 3Zm-1 5v6.5h2V8h-2Zm0 8v2h2v-2h-2Z',
  /** Nothing wrong here. */
  check: 'M9.5 18 4 12.5l1.9-1.9 3.6 3.6 8.6-8.6 1.9 1.9L9.5 18Z',
  /** Do the books balance: a scale, level. */
  books:
    'M12 2.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2ZM3 6.4h18V8H3V6.4Zm8.2 1.6h1.6v10.4h-1.6V8Zm-4.2 10.4h10v2.2H7v-2.2ZM2.6 9h6.8L6 15.4 2.6 9Zm12 0h6.8L18 15.4 14.6 9Z',
};

export interface IconProps {
  name: IconName;
  className?: string;
}

export function Icon({ name, className = 'h-5 w-5' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
