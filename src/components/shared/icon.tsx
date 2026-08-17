import type { IconName } from './navigation';

/**
 * Inline SVG icon set.
 *
 * Hand-rolled rather than pulled from an icon package: it keeps the client
 * bundle small on a shop's phone over a slow connection, and there are only a
 * dozen of them.
 */

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
  users:
    'M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.4-8 5.3V22h16v-2.7c0-2.9-3.6-5.3-8-5.3Z',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.4 4a7.6 7.6 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L16.5 3h-4l-.4 2.6c-.7.3-1.4.7-2 1.2l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
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
