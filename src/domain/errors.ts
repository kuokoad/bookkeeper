/**
 * Typed error hierarchy for the domain layer.
 *
 * Domain code throws these; the service layer lets them propagate (rolling back
 * the surrounding database transaction); the action layer converts them into
 * user-facing messages. Nothing is ever silently swallowed.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'MONEY_OVERFLOW'
  | 'INSUFFICIENT_STOCK'
  | 'UNBALANCED_ENTRY'
  | 'INVARIANT_VIOLATED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED';

export class DomainError extends Error {
  readonly code: ErrorCode;
  /** Safe to show a shop owner. Never contains internals or secrets. */
  readonly userMessage: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    userMessage?: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.userMessage = userMessage ?? message;
    this.details = Object.freeze({ ...details });
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION', message, message, details);
  }
}

/** A money/quantity computation left the safe integer range. Never ignore this. */
export class MoneyOverflowError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      'MONEY_OVERFLOW',
      message,
      'That amount is too large for the system to handle safely.',
      details,
    );
  }
}

export class InsufficientStockError extends DomainError {
  constructor(productName: string, available: string, requested: string) {
    super(
      'INSUFFICIENT_STOCK',
      `Insufficient stock for ${productName}: available ${available}, requested ${requested}`,
      `Not enough stock for ${productName}. Available: ${available}, requested: ${requested}.`,
      { productName, available, requested },
    );
  }
}

/** Debits did not equal credits. The transaction must roll back. */
export class UnbalancedEntryError extends DomainError {
  constructor(totalDebit: number, totalCredit: number, details?: Record<string, unknown>) {
    super(
      'UNBALANCED_ENTRY',
      `Journal entry does not balance: debit ${totalDebit} !== credit ${totalCredit}`,
      'This transaction could not be saved because its accounting entries did not balance. Nothing was changed.',
      { totalDebit, totalCredit, ...details },
    );
  }
}

export class InvariantViolatedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(
      'INVARIANT_VIOLATED',
      message,
      'The system detected inconsistent data and stopped to protect your records.',
      details,
    );
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string | number) {
    super('NOT_FOUND', `${entity} not found: ${id}`, `That ${entity.toLowerCase()} could not be found.`, {
      entity,
      id,
    });
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, message, details);
  }
}

export class ForbiddenError extends DomainError {
  /**
   * `userMessage` is optional because most refusals are best left vague: telling
   * someone precisely which door is locked is a courtesy to the wrong person.
   * Supply one where the refusal is an ordinary part of somebody's day and the
   * generic line would just be baffling — a cashier told "you do not have
   * permission to do that" after typing a discount has no idea what to do next.
   */
  constructor(action: string, userMessage?: string) {
    super(
      'FORBIDDEN',
      `Not permitted: ${action}`,
      userMessage ?? 'You do not have permission to do that.',
      { action },
    );
  }
}

export class UnauthenticatedError extends DomainError {
  constructor() {
    super('UNAUTHENTICATED', 'No valid session', 'Please sign in to continue.');
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
