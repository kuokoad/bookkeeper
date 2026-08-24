import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import {
  accounts,
  businessSettings,
  purchaseTaxes,
  saleTaxes,
  taxComponents,
  TAX_BASES,
  type TaxBasis,
} from '@/db/schema';
import {
  ConflictError,
  InvariantViolatedError,
  NotFoundError,
  ValidationError,
} from '@/domain/errors';
import { minor, type Minor } from '@/domain/money';
import {
  taxOnNet,
  taxWithinGross,
  totalRateBp,
  type TaxBreakdown,
  type TaxComponent,
} from '@/domain/tax/components';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * What this shop charges, and how it applies to a sale.
 *
 * The components live in the database so a budget change is a settings edit
 * rather than a new version of the software. Everything else about them —
 * how they combine, how the parts are rounded — is in the domain, which knows
 * nothing about tables.
 */

export interface ShopTaxProfile {
  /** Active components, in the order they should appear on a receipt. */
  components: TaxComponent[];
  /** The database id for each, so postings can find the right account. */
  accountIdByCode: Map<string, number>;
  componentIdByCode: Map<string, number>;
  /**
   * The ALL-IN rate in basis points — what the customer pays over the net.
   * Not the sum of the rates: a component charged on net-plus-levies makes
   * the true figure larger than adding the percentages suggests.
   */
  totalRateBp: number;
  /** Whether the shop charges tax at all. */
  enabled: boolean;
  /** Whether shelf prices already include it. */
  inclusive: boolean;
}

/**
 * Read the shop's tax setup.
 *
 * Returns an EMPTY component list when tax is switched off, so callers do not
 * each have to remember to check: charging nothing is expressed as having
 * nothing to charge, not as a flag they might forget.
 */
export function getTaxProfile(db: Db | Tx): ShopTaxProfile {
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const enabled = settings?.taxEnabled ?? false;
  const inclusive = settings?.taxInclusive ?? false;

  const rows = enabled
    ? db
        .select()
        .from(taxComponents)
        .where(and(eq(taxComponents.isActive, true)))
        .orderBy(asc(taxComponents.sortOrder), asc(taxComponents.id))
        .all()
        .filter((row) => row.rateBp > 0)
    : [];

  // Mapped once and reused: the rate depends on how the components combine,
  // so it must be derived from the same list the caller will charge with.
  const components: TaxComponent[] = rows.map((row) => ({
    code: row.code,
    name: row.name,
    rateBp: row.rateBp,
    basis: row.basis,
    isRecoverable: row.isRecoverable,
  }));

  return {
    components,
    accountIdByCode: new Map(rows.map((row) => [row.code, row.glAccountId])),
    componentIdByCode: new Map(rows.map((row) => [row.code, row.id])),
    totalRateBp: totalRateBp(components),
    enabled,
    inclusive,
  };
}

/**
 * Work out the tax on an amount, whichever way the shop prices its shelves.
 *
 * `amount` is the net goods value when prices exclude tax, and the price on the
 * label when they include it. The distinction is the shop's setting, not the
 * caller's business, which is why it is resolved here.
 */
export function applyTax(profile: ShopTaxProfile, amount: Minor): TaxBreakdown {
  return profile.inclusive
    ? taxWithinGross(amount, profile.components)
    : taxOnNet(amount, profile.components);
}

/** Total of the recoverable components only — what a purchase can reclaim. */
export function recoverableTotal(lines: readonly { isRecoverable: boolean; amount: Minor }[]): Minor {
  return minor(
    lines.reduce((running, line) => running + (line.isRecoverable ? line.amount : 0), 0),
  );
}

/** Total of the components that are NOT reclaimable — part of what goods cost. */
export function nonRecoverableTotal(
  lines: readonly { isRecoverable: boolean; amount: Minor }[],
): Minor {
  return minor(
    lines.reduce((running, line) => running + (line.isRecoverable ? 0 : line.amount), 0),
  );
}

// --- recording on a document ----------------------------------------------

/**
 * The account a component's tax is held in.
 *
 * Resolved by id where the document recorded one, because that survives a
 * rename; by code otherwise. A component that has since been removed falls
 * back to the general tax account rather than failing — the shop still owes
 * (or has stopped owing) the money, and refusing to record a return because
 * somebody tidied up a rate would be worse than booking it one account over.
 */
export function taxAccountFor(
  tx: Tx,
  line: { componentId?: number | null; code: string },
): number {
  if (typeof line.componentId === 'number') {
    const byId = tx
      .select({ glAccountId: taxComponents.glAccountId })
      .from(taxComponents)
      .where(eq(taxComponents.id, line.componentId))
      .get();
    if (byId) return byId.glAccountId;
  }

  const byCode = tx
    .select({ glAccountId: taxComponents.glAccountId })
    .from(taxComponents)
    .where(eq(taxComponents.code, line.code))
    .get();
  if (byCode) return byCode.glAccountId;

  const fallback = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.code, TAX_PAYABLE_CODE))
    .get();
  if (!fallback) {
    throw new InvariantViolatedError(`No account to hold ${line.code} tax in.`, { code: line.code });
  }
  return fallback.id;
}

/** The general tax account, used only when a component has been removed. */
const TAX_PAYABLE_CODE = '2100';

export interface RecordedTaxLine {
  code: string;
  name: string;
  rateBp: number;
  basis: TaxBasis;
  amount: Minor;
  isRecoverable: boolean;
}

/**
 * Snapshot what a sale actually charged.
 *
 * The code, name, rate and basis are COPIED onto the document rather than
 * pointed at. A receipt reprinted after the budget moves VAT has to show what
 * the customer was charged on the day, and a return filed for last month has
 * to be worked out from what was actually collected.
 */
export function writeSaleTaxes(
  tx: Tx,
  saleId: number,
  lines: readonly RecordedTaxLine[],
  componentIdByCode: ReadonlyMap<string, number>,
  at: Date,
): void {
  for (const line of lines) {
    if (line.amount === 0) continue;
    tx.insert(saleTaxes)
      .values({
        saleId,
        componentId: componentIdByCode.get(line.code) ?? null,
        code: line.code,
        name: line.name,
        rateBp: line.rateBp,
        basis: line.basis,
        amountMinor: line.amount,
        createdAt: at,
      })
      .run();
  }
}

/** The same, for tax paid to a supplier. */
export function writePurchaseTaxes(
  tx: Tx,
  purchaseId: number,
  lines: readonly RecordedTaxLine[],
  componentIdByCode: ReadonlyMap<string, number>,
  at: Date,
): void {
  for (const line of lines) {
    if (line.amount === 0) continue;
    tx.insert(purchaseTaxes)
      .values({
        purchaseId,
        componentId: componentIdByCode.get(line.code) ?? null,
        code: line.code,
        name: line.name,
        rateBp: line.rateBp,
        basis: line.basis,
        amountMinor: line.amount,
        isRecoverable: line.isRecoverable,
        createdAt: at,
      })
      .run();
  }
}

/** What a sale charged, as recorded on the day. */
export function readSaleTaxes(tx: Tx, saleId: number) {
  return tx
    .select()
    .from(saleTaxes)
    .where(eq(saleTaxes.saleId, saleId))
    .orderBy(asc(saleTaxes.id))
    .all();
}

// --- setup ----------------------------------------------------------------

/**
 * Editing the shop's taxes.
 *
 * The whole reason these live in a table is that Ghana changes them with the
 * national budget, so the shop has to be able to change them too: without
 * waiting for a new version of the software, and without being able to put its
 * books into a state that cannot be filed.
 */

export interface TaxComponentInput {
  code: string;
  name: string;
  rateBp: number;
  basis: TaxBasis;
  isRecoverable: boolean;
  glAccountId: number;
  sortOrder?: number;
  isActive?: boolean;
}

interface CleanTaxComponent {
  code: string;
  name: string;
  rateBp: number;
  basis: TaxBasis;
  isRecoverable: boolean;
  glAccountId: number;
  sortOrder: number;
  isActive: boolean;
}

/** Codes are matched in code and printed on returns, so they are narrow on purpose. */
const CODE_PATTERN = /^[A-Z0-9_]{1,20}$/;

function cleanInput(input: TaxComponentInput): CleanTaxComponent {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();

  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError(
      'A tax code is up to 20 letters, digits or underscores, like VAT or NHIL.',
      { code: input.code },
    );
  }
  if (name.length === 0) throw new ValidationError('Enter a name for the tax.');
  if (!Number.isInteger(input.rateBp)) {
    throw new ValidationError('Enter the rate as a whole number of basis points.');
  }
  if (input.rateBp < 0 || input.rateBp > 100_000) {
    throw new ValidationError('A tax rate must be between 0% and 1000%.', { rateBp: input.rateBp });
  }
  if (!TAX_BASES.includes(input.basis)) {
    throw new ValidationError('Choose what the tax is charged on.', { basis: input.basis });
  }

  return {
    code,
    name,
    rateBp: input.rateBp,
    basis: input.basis,
    isRecoverable: input.isRecoverable,
    glAccountId: input.glAccountId,
    sortOrder: input.sortOrder ?? 0,
    isActive: input.isActive ?? true,
  };
}

/**
 * The account a tax is held in must be a liability the shop owes.
 *
 * Pointing a tax at revenue would book money the shop is holding for the
 * authority as money it earned: profit overstated by every pesewa collected,
 * and the debt to the authority nowhere on the balance sheet.
 */
function assertHoldingAccount(tx: Tx, glAccountId: number): void {
  const account = tx
    .select({ type: accounts.type, isActive: accounts.isActive, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, glAccountId))
    .get();

  if (!account) throw new NotFoundError('Account', glAccountId);
  if (account.type !== 'LIABILITY') {
    throw new ValidationError(
      `Tax collected has to be held in a liability account. "${account.name}" is ${account.type.toLowerCase()}.`,
      { glAccountId },
    );
  }
  if (!account.isActive) {
    throw new ValidationError(`"${account.name}" is archived, so tax cannot be held in it.`, {
      glAccountId,
    });
  }
}

/**
 * Keep `businessSettings.taxRateBp` and `taxLabel` in step with the components.
 *
 * Nothing prices a sale from them any more — sales, returns and purchases all
 * read the component list directly. They are kept up to date because they are
 * still on the settings row, still shown in the change history, and a stale
 * number sitting beside a live one is a trap for whoever reads it next.
 *
 * The rate is the ALL-IN figure. The single label cannot name three taxes, so
 * it says "Tax" unless there is only one.
 */
export function syncDerivedTaxSettings(tx: Tx, at: Date = new Date()): void {
  const active = tx
    .select()
    .from(taxComponents)
    .where(eq(taxComponents.isActive, true))
    .orderBy(asc(taxComponents.sortOrder), asc(taxComponents.id))
    .all()
    .filter((row) => row.rateBp > 0);

  const components: TaxComponent[] = active.map((row) => ({
    code: row.code,
    name: row.name,
    rateBp: row.rateBp,
    basis: row.basis,
    isRecoverable: row.isRecoverable,
  }));

  const only = components.length === 1 ? components[0]!.name.slice(0, 20) : null;

  tx.update(businessSettings)
    .set({
      taxRateBp: totalRateBp(components),
      // Never blank: the column is NOT NULL and it labels the change history.
      taxLabel: only ?? 'Tax',
      updatedAt: at,
    })
    .where(eq(businessSettings.id, 1))
    .run();
}

/**
 * The all-in rate, whether or not the shop is currently charging tax.
 *
 * `getTaxProfile` reports nothing when tax is switched off, which is right for
 * pricing a sale and wrong for a settings screen: the owner still needs to see
 * what they have set up before they switch it on.
 */
export function allInTaxRateBp(db: Db | Tx): number {
  const rows = db
    .select()
    .from(taxComponents)
    .where(eq(taxComponents.isActive, true))
    .orderBy(asc(taxComponents.sortOrder), asc(taxComponents.id))
    .all()
    .filter((row) => row.rateBp > 0);

  return totalRateBp(
    rows.map((row) => ({
      code: row.code,
      name: row.name,
      rateBp: row.rateBp,
      basis: row.basis,
      isRecoverable: row.isRecoverable,
    })),
  );
}

/**
 * The accounts a tax may be held in.
 *
 * Liabilities only, and postable ones: tax collected is money owed to the
 * authority, and a heading exists to group its children rather than to hold a
 * balance of its own.
 */
export function listTaxHoldingAccounts(db: Db | Tx) {
  const rows = db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.type, 'LIABILITY'), eq(accounts.isActive, true)))
    .orderBy(asc(accounts.code))
    .all();

  // A heading is an account with children. Filtered here rather than with a
  // correlated subquery: drizzle only qualifies column names when the outer
  // query has a join, so `WHERE parent_id = id` on a single-table select binds
  // to the wrong table and silently returns nonsense. See catalog.service.
  const headings = new Set(
    db
      .select({ parentId: accounts.parentId })
      .from(accounts)
      .where(isNotNull(accounts.parentId))
      .all()
      .map((row) => row.parentId),
  );

  return rows.filter((row) => !headings.has(row.id));
}

/** Every component, in the order they appear on a receipt. */
export function listTaxComponents(db: Db | Tx, includeInactive = true) {
  const query = db.select().from(taxComponents);
  const filtered = includeInactive ? query : query.where(eq(taxComponents.isActive, true));
  return filtered.orderBy(asc(taxComponents.sortOrder), asc(taxComponents.id)).all();
}

export function createTaxComponent(db: Db, input: TaxComponentInput, actor: Actor): number {
  const clean = cleanInput(input);

  return writeTransaction(db, (tx) => {
    assertHoldingAccount(tx, clean.glAccountId);

    const clash = tx
      .select({ id: taxComponents.id })
      .from(taxComponents)
      .where(eq(taxComponents.code, clean.code))
      .get();
    if (clash) throw new ConflictError(`A tax with the code "${clean.code}" already exists.`);

    const now = new Date();
    const inserted = tx
      .insert(taxComponents)
      .values({ ...clean, createdAt: now, updatedAt: now })
      .returning({ id: taxComponents.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create that tax.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'tax_component',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Added ${clean.name} at ${clean.rateBp / 100}%`,
      metadata: { ...clean },
      at: now,
    });

    syncDerivedTaxSettings(tx, now);
    return inserted.id;
  });
}

/**
 * Change a tax.
 *
 * Applies from now on. Sales already recorded keep what they charged, because
 * `sale_taxes` snapshots the rate on every document: a return filed for last
 * month is worked out from what was actually collected, not from what the shop
 * charges today.
 */
export function updateTaxComponent(
  db: Db,
  id: number,
  input: TaxComponentInput,
  actor: Actor,
): void {
  const clean = cleanInput(input);

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(taxComponents).where(eq(taxComponents.id, id)).get();
    if (!existing) throw new NotFoundError('Tax', id);

    assertHoldingAccount(tx, clean.glAccountId);

    const clash = tx
      .select({ id: taxComponents.id })
      .from(taxComponents)
      .where(and(eq(taxComponents.code, clean.code), ne(taxComponents.id, id)))
      .get();
    if (clash) throw new ConflictError(`A tax with the code "${clean.code}" already exists.`);

    const now = new Date();
    tx.update(taxComponents)
      .set({ ...clean, updatedAt: now })
      .where(eq(taxComponents.id, id))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'tax_component',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: describeChange(existing, clean),
      metadata: { before: { ...existing }, after: { ...clean } },
      at: now,
    });

    syncDerivedTaxSettings(tx, now);
  });
}

/**
 * Say what actually moved.
 *
 * "Updated tax" tells nobody why last Tuesday's receipts stopped matching this
 * Tuesday's. The rate change is the one a shop will come looking for.
 */
function describeChange(
  before: { rateBp: number; basis: TaxBasis; name: string; code: string; isActive: boolean; isRecoverable: boolean; glAccountId: number },
  after: CleanTaxComponent,
): string {
  const changes: string[] = [];

  if (before.rateBp !== after.rateBp) {
    changes.push(`rate ${before.rateBp / 100}% to ${after.rateBp / 100}%`);
  }
  if (before.basis !== after.basis) {
    changes.push(
      after.basis === 'NET_PLUS_LEVIES'
        ? 'now charged on the value plus the levies before it'
        : 'now charged on the value alone',
    );
  }
  if (before.name !== after.name) changes.push(`renamed to ${after.name}`);
  if (before.code !== after.code) changes.push(`code ${before.code} to ${after.code}`);
  if (before.isActive !== after.isActive) {
    changes.push(after.isActive ? 'switched on' : 'switched off');
  }
  if (before.isRecoverable !== after.isRecoverable) {
    changes.push(after.isRecoverable ? 'reclaimable on purchases' : 'no longer reclaimable');
  }
  if (before.glAccountId !== after.glAccountId) changes.push('held in a different account');

  return changes.length > 0
    ? `${before.name}: ${changes.join(', ')}`
    : `${before.name}: saved with nothing changed`;
}

/**
 * How many documents have already charged this tax.
 *
 * Shown before switching one off, so the owner knows whether they are turning
 * off something theoretical or something that is on hundreds of receipts.
 */
export function taxComponentUsage(db: Db | Tx, id: number): number {
  const sales = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(saleTaxes)
    .where(eq(saleTaxes.componentId, id))
    .get();
  const purchases = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(purchaseTaxes)
    .where(eq(purchaseTaxes.componentId, id))
    .get();

  return (sales?.n ?? 0) + (purchases?.n ?? 0);
}

/*
 * There is deliberately no way to DELETE a tax component.
 *
 * The moment one has been charged, the row stops being configuration and
 * becomes part of the record — removing it would cut the link from a receipt
 * to the thing it charged. And one that has never been charged does not need
 * deleting: correct the code and the name and it becomes whatever it should
 * have been. The audit vocabulary has no DELETE for the same reason.
 */

/** Switch a tax on or off without touching its rate. */
export function setTaxComponentActive(db: Db, id: number, isActive: boolean, actor: Actor): void {
  writeTransaction(db, (tx) => {
    const existing = tx.select().from(taxComponents).where(eq(taxComponents.id, id)).get();
    if (!existing) throw new NotFoundError('Tax', id);
    if (existing.isActive === isActive) return;

    const now = new Date();
    tx.update(taxComponents).set({ isActive, updatedAt: now }).where(eq(taxComponents.id, id)).run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'tax_component',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${existing.name} ${isActive ? 'switched on' : 'switched off'}`,
      at: now,
    });

    syncDerivedTaxSettings(tx, now);
  });
}
