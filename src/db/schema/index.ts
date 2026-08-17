/**
 * Schema barrel — the single entry point drizzle-kit reads.
 *
 * Tables are introduced stage by stage; each stage adds its own module here and
 * generates an additive migration. Nothing is ever edited in place once a
 * migration has been applied to a real shop database.
 *
 * Stage 1 (foundation): system, users, accounting core.
 * Stage 2 adds catalog + inventory, Stage 3 sales, Stage 4 purchases, and so on.
 */

export * from './_shared';
export * from './system';
export * from './users';
export * from './parties';
export * from './suppliers';
export * from './accounting';
export * from './catalog';
export * from './inventory';
export * from './sales';
export * from './purchases';
export * from './cashbook';
export * from './reconciliation';
