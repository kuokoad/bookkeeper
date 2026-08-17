import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';

import type { Tx } from '@/db/types';
import { sequences } from '@/db/schema';
import { InvariantViolatedError } from '@/domain/errors';

/**
 * Atomic document numbering.
 *
 * MUST be called inside the same transaction as the document being numbered.
 * The increment and the read happen in one UPDATE ... RETURNING statement, so
 * two concurrent sales cannot be handed the same receipt number even when the
 * shop has the till open on two devices.
 */

export const DOC_TYPES = {
  RECEIPT: 'RECEIPT',
  SALE_RETURN: 'SALE_RETURN',
  PURCHASE: 'PURCHASE',
  PURCHASE_RETURN: 'PURCHASE_RETURN',
  JOURNAL: 'JOURNAL',
  PAYMENT_IN: 'PAYMENT_IN',
  PAYMENT_OUT: 'PAYMENT_OUT',
  EXPENSE: 'EXPENSE',
  INCOME: 'INCOME',
  ADJUSTMENT: 'ADJUSTMENT',
  RECONCILIATION: 'RECONCILIATION',
} as const;

export type DocType = (typeof DOC_TYPES)[keyof typeof DOC_TYPES];

export const DEFAULT_SEQUENCES: readonly { docType: DocType; prefix: string; padding: number }[] = [
  { docType: DOC_TYPES.RECEIPT, prefix: 'RCP-', padding: 5 },
  { docType: DOC_TYPES.SALE_RETURN, prefix: 'SRT-', padding: 5 },
  { docType: DOC_TYPES.PURCHASE, prefix: 'PUR-', padding: 5 },
  { docType: DOC_TYPES.PURCHASE_RETURN, prefix: 'PRT-', padding: 5 },
  { docType: DOC_TYPES.JOURNAL, prefix: 'JE-', padding: 6 },
  { docType: DOC_TYPES.PAYMENT_IN, prefix: 'RCV-', padding: 5 },
  { docType: DOC_TYPES.PAYMENT_OUT, prefix: 'PAY-', padding: 5 },
  { docType: DOC_TYPES.EXPENSE, prefix: 'EXP-', padding: 5 },
  { docType: DOC_TYPES.INCOME, prefix: 'INC-', padding: 5 },
  { docType: DOC_TYPES.ADJUSTMENT, prefix: 'ADJ-', padding: 5 },
  { docType: DOC_TYPES.RECONCILIATION, prefix: 'REC-', padding: 5 },
];

export function formatDocumentNumber(prefix: string, value: number, padding: number): string {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}

/**
 * Reserve and return the next document number for `docType`.
 * Throws if the sequence row is missing — a silent fallback would risk two
 * documents sharing a number, which is worse than a failed save.
 */
export function nextDocumentNumber(tx: Tx, docType: DocType): string {
  const updated = tx
    .update(sequences)
    .set({
      nextNumber: sql`${sequences.nextNumber} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sequences.docType, docType))
    .returning({
      nextNumber: sequences.nextNumber,
      prefix: sequences.prefix,
      padding: sequences.padding,
    })
    .get();

  if (!updated) {
    throw new InvariantViolatedError(
      `No numbering sequence configured for document type "${docType}".`,
      { docType },
    );
  }

  // `nextNumber` now holds the incremented value, so the number just reserved
  // is one below it.
  const reserved = updated.nextNumber - 1;
  return formatDocumentNumber(updated.prefix, reserved, updated.padding);
}

/** Peek without consuming — for previewing "next receipt will be RCP-00042". */
export function peekDocumentNumber(tx: Tx, docType: DocType): string | null {
  const row = tx.select().from(sequences).where(eq(sequences.docType, docType)).get();
  if (!row) return null;
  return formatDocumentNumber(row.prefix, row.nextNumber, row.padding);
}
