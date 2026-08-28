import { LOOKS, type Look } from '@/db/schema/system';

export { LOOKS, type Look };

/**
 * Which look the shop's screens wear.
 *
 * The counterpart to `theme.ts`, and stored the opposite way round on purpose.
 * Light or dark is a property of the SCREEN you are standing at, so it lives in
 * a cookie. Which look the shop wears is a property of the SHOP: decided once,
 * the same on the counter PC and the owner's phone, and changed by the owner in
 * Settings where it is audited like every other shop choice.
 *
 * The two settings are independent. Every combination of look and brightness is
 * painted in globals.css, so choosing Ledger never quietly overrides somebody's
 * dark mode.
 *
 * This half is pure so it can be tested without a database.
 */

export function isLook(value: unknown): value is Look {
  return typeof value === 'string' && (LOOKS as readonly string[]).includes(value);
}

/**
 * What to put on `<html>`.
 *
 * The default look sets NO attribute, exactly as `theme.ts` sets none for
 * 'system'. A shop that has never touched this ships the same markup it always
 * did, and the Ledger rules in globals.css are all keyed on the attribute being
 * present — so the default look cannot be affected by them even by accident.
 */
export function lookAttribute(look: Look): { 'data-look'?: 'ledger' } {
  return look === 'default' ? {} : { 'data-look': look };
}

/** The names a shop owner sees, and what each one is for. */
export const LOOK_LABELS: Record<Look, { name: string; blurb: string }> = {
  default: {
    name: 'Standard',
    blurb: 'Crisp and neutral, with a dark menu. Best in a bright shop.',
  },
  ledger: {
    name: 'Ledger',
    blurb: 'Warm and paper-like, the feel of the book this replaced.',
  },
};
