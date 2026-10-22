/**
 * How long the purchase action lets each free-text field be.
 *
 * Shared with the new-purchase form so the box stops where the server would
 * refuse, rather than after Save with a message about string lengths. A
 * 'use server' module can only export async functions, so the numbers live
 * here and both sides import them.
 */
export const INVOICE_NO_MAX = 60;
export const PURCHASE_NOTE_MAX = 300;
export const PAYMENT_REFERENCE_MAX = 80;
