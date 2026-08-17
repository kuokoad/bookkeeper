import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { customers, paymentAccounts, products, sales } from '@/db/schema';
import { createCustomer } from '@/services/customer.service';
import { createSale } from '@/services/sale.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, parseQty, type Qty } from '@/domain/quantity';
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
  if (!cash || !momo) return;

  const need = (name: string): number => {
    const id = productByName.get(name);
    if (id === undefined) throw new Error(`Demo seed expected product "${name}"`);
    return id;
  };

  // --- customers ---------------------------------------------------------
  const ama = createCustomer(
    db,
    { name: 'Ama Serwaa', phone: '024 111 2233', creditLimit: m(500) },
    actor,
  );
  const kofi = createCustomer(
    db,
    { name: 'Kofi Mensah', phone: '020 444 5566', creditLimit: null },
    actor,
  );
  const chopBar = createCustomer(
    db,
    { name: 'Auntie Akos Chop Bar', phone: '027 777 8899', creditLimit: m(1_000) },
    actor,
  );
  db.update(customers).set({ isDemo: true }).run();

  // --- a few days of trading --------------------------------------------
  // Day -3: two straightforward cash sales.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 3),
      items: [
        { productId: need('Coca-Cola 350ml'), qty: u(6) },
        { productId: need('Digestive Biscuits'), qty: u(2) },
      ],
      tenders: [{ paymentAccountId: cash.id, amount: m(52) }],
      isDemo: true,
    },
    actor,
  );

  createSale(
    db,
    {
      businessDate: daysBefore(today, 3),
      items: [{ productId: need('Milo Tin 400g'), qty: u(1) }],
      tenders: [{ paymentAccountId: momo.id, amount: m(46), reference: 'MM-8821004' }],
      isDemo: true,
    },
    actor,
  );

  // Day -2: a MoMo sale and a credit sale to the chop bar.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 2),
      items: [
        { productId: need('Bottled Water 750ml'), qty: u(12) },
        { productId: need('Groundnuts 100g'), qty: u(5) },
      ],
      tenders: [{ paymentAccountId: momo.id, amount: m(56), reference: 'MM-8830117' }],
      isDemo: true,
    },
    actor,
  );

  createSale(
    db,
    {
      businessDate: daysBefore(today, 2),
      customerId: chopBar,
      items: [
        { productId: need('Rice (local)'), qty: parseQty('10') },
        { productId: need('Evaporated Milk 170g'), qty: u(12) },
      ],
      // Part paid now, the rest on credit.
      tenders: [{ paymentAccountId: cash.id, amount: m(100) }],
      note: 'Weekly supply',
      isDemo: true,
    },
    actor,
  );

  // Day -1: a discounted sale and a fully-credit sale.
  createSale(
    db,
    {
      businessDate: daysBefore(today, 1),
      items: [
        { productId: need('Key Soap'), qty: u(4) },
        { productId: need('Tea Bread'), qty: u(1) },
      ],
      invoiceDiscount: m(2),
      tenders: [{ paymentAccountId: cash.id, amount: m(34) }],
      isDemo: true,
    },
    actor,
  );

  createSale(
    db,
    {
      businessDate: daysBefore(today, 1),
      customerId: ama,
      items: [{ productId: need('Milo Tin 400g'), qty: u(2) }],
      tenders: [],
      note: 'Pay end of week',
      isDemo: true,
    },
    actor,
  );

  // Today: a split-payment sale, plus Ama settling part of her debt.
  createSale(
    db,
    {
      businessDate: today,
      customerId: kofi,
      items: [
        { productId: need('Coca-Cola 350ml'), qty: u(12) },
        { productId: need('Bottled Water 750ml'), qty: u(6) },
      ],
      tenders: [
        { paymentAccountId: cash.id, amount: m(50) },
        { paymentAccountId: momo.id, amount: m(40), reference: 'MM-8844290' },
      ],
      isDemo: true,
    },
    actor,
  );

  recordCustomerPayment(
    db,
    {
      customerId: ama,
      businessDate: today,
      paymentAccountId: momo.id,
      amount: m(50),
      reference: 'MM-8844311',
      isDemo: true,
    },
    actor,
  );

  db.update(sales).set({ isDemo: true }).where(eq(sales.isDemo, false)).run();
}
