import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { customers, paymentAccounts, products, sales } from '@/db/schema';
import { createCustomer } from '@/services/customer.service';
import { createSale } from '@/services/sale.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import type { Actor } from '@/services/journal.service';

/**
 * Demo trading history: a few days of plausible sales.
 *
 * Every one goes through the REAL `createSale` path, so the demo database
 * exercises stock movements, weighted-average COGS and balanced journal entries
 * exactly as production does. Nothing here writes a total or a balance directly.
 */

const m = (cedis: number): Minor => minor(Math.round(cedis * 100));
const u = (units: number): Qty => fromUnits(units);

/** N days before the given date, as 'YYYY-MM-DD'. */
function daysBefore(businessDate: string, days: number): string {
  const [year, month, day] = businessDate.split('-').map(Number);
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function seedDemoSales(db: Db, actor: Actor, today: string): void {
  // Idempotent: never seed twice.
  if (db.select({ id: sales.id }).from(sales).limit(1).get()) return;

  const productByName = new Map(
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .all()
      .map((row) => [row.name, row.id]),
  );

  const accounts = db.select().from(paymentAccounts).all();
  const cash = accounts.find((account) => account.kind === 'CASH');
  const momo = accounts.find((account) => account.kind === 'MOBILE_MONEY');
  // A yard is paid into the bank far more often than a corner shop is: a
  // contractor settling forty thousand cedis does not hand over a bag of notes.
  const bank = accounts.find((account) => account.kind === 'BANK');
  if (!cash || !momo || !bank) return;

  const need = (name: string): number => {
    const id = productByName.get(name);
    if (id === undefined) throw new Error(`Demo seed expected product "${name}"`);
    return id;
  };

  // --- customers ---------------------------------------------------------
  //
  // Contractors, not shoppers. A materials yard's book is a handful of building
  // firms on terms, which is what makes receivables and the ageing report worth
  // looking at.
  const adom = createCustomer(
    db,
    {
      name: 'Adom Construction Ltd',
      phone: '024 111 2233',
      address: 'Adenta, Accra',
      creditLimit: m(60_000),
    },
    actor,
  );
  const mensah = createCustomer(
    db,
    { name: 'Mensah & Sons Builders', phone: '020 444 5566', creditLimit: m(25_000) },
    actor,
  );
  const walkIn = createCustomer(
    db,
    { name: 'Kofi Owusu', phone: '027 777 8899', creditLimit: null },
    actor,
  );
  db.update(customers).set({ isDemo: true }).run();

  // --- a few months of trading -------------------------------------------
  //
  // Spread across time on purpose: Profit and Loss, the trend charts and the
  // year-end pack all demonstrate nothing against a single day's takings.

  // Two months back: a big cash order off the yard.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 63),
      items: [
        { productId: need('Cement 50kg'), qty: u(120) },
        { productId: need('Iron rod 12mm'), qty: u(40) },
      ],
      tenders: [{ paymentAccountId: cash.id, amount: m(16_000) }],
      isDemo: true,
    },
    actor,
  );

  // A contractor on terms. This is what puts something in receivables.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 55),
      customerId: adom,
      termsDays: 30,
      items: [
        { productId: need('Cement 50kg'), qty: u(300) },
        { productId: need('Sand (tipper load)'), qty: u(2) },
        { productId: need('Chippings 3/4in (tipper load)'), qty: u(1) },
        { productId: need('Cartage to site'), qty: u(2) },
      ],
      tenders: [{ paymentAccountId: bank.id, amount: m(10_000) }],
      note: 'Adenta site, phase 1',
      isDemo: true,
    },
    actor,
  );

  createSale(
    db,
    {
      businessDate: daysBefore(today, 41),
      items: [
        { productId: need('Roofing sheet aluzinc 3m'), qty: u(24) },
        { productId: need('Roofing nails 3in'), qty: u(8) },
      ],
      tenders: [{ paymentAccountId: momo.id, amount: m(5_288) }],
      isDemo: true,
    },
    actor,
  );

  // Split tender: part cash, part mobile money, which is how a yard is paid.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 28),
      customerId: mensah,
      items: [
        { productId: need('PVC pipe 4in'), qty: u(18) },
        { productId: need('PVC pipe 2in'), qty: u(24) },
        { productId: need('PVC elbow 4in'), qty: u(30) },
      ],
      tenders: [
        { paymentAccountId: cash.id, amount: m(2_000) },
        { paymentAccountId: momo.id, amount: m(2_908) },
      ],
      isDemo: true,
    },
    actor,
  );

  // Part paid, so this one sits in the ageing.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 21),
      customerId: mensah,
      termsDays: 30,
      items: [
        { productId: need('Iron rod 16mm'), qty: u(60) },
        { productId: need('Binding wire'), qty: u(6) },
      ],
      tenders: [{ paymentAccountId: bank.id, amount: m(4_000) }],
      note: 'Kasoa site',
      isDemo: true,
    },
    actor,
  );

  createSale(
    db,
    {
      businessDate: daysBefore(today, 12),
      customerId: walkIn,
      items: [
        { productId: need('Cement 50kg'), qty: u(15) },
        { productId: need('Roofing nails 3in'), qty: u(3) },
      ],
      tenders: [{ paymentAccountId: cash.id, amount: m(1_497) }],
      isDemo: true,
    },
    actor,
  );

  // Yesterday, and a negotiated price: quoting and haggling is the trade.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 1),
      customerId: adom,
      termsDays: 30,
      items: [
        { productId: need('Cement 50kg'), qty: u(200), unitPrice: m(93) },
        { productId: need('Cartage to site'), qty: u(1) },
      ],
      tenders: [],
      allowPriceOverride: true,
      note: 'Adenta site, phase 2',
      isDemo: true,
    },
    actor,
  );

  // Something taken off the account.
  recordCustomerPayment(
    db,
    {
      customerId: adom,
      businessDate: daysBefore(today, 30),
      paymentAccountId: bank.id,
      amount: m(20_000),
      reference: 'Cheque 004412',
      isDemo: true,
    },
    actor,
  );

  db.update(sales).set({ isDemo: true }).where(eq(sales.isDemo, false)).run();
}
