import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { paymentAccounts, products, purchases, suppliers } from '@/db/schema';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { recordSupplierPayment } from '@/services/supplier-payment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import type { Actor } from '@/services/journal.service';

/**
 * Demo suppliers and deliveries.
 *
 * As with the sales seed, everything goes through the REAL service path, so the
 * demo database exercises stock re-averaging, payables and balanced journal
 * entries exactly as production does.
 */

const m = (cedis: number): Minor => minor(Math.round(cedis * 100));
const u = (units: number): Qty => fromUnits(units);

function daysBefore(businessDate: string, days: number): string {
  const [year, month, day] = businessDate.split('-').map(Number);
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function seedDemoPurchases(db: Db, actor: Actor, today: string): void {
  if (db.select({ id: purchases.id }).from(purchases).limit(1).get()) return;

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
  const bank = accounts.find((account) => account.kind === 'BANK');
  if (!cash || !momo || !bank) return;

  const need = (name: string): number => {
    const id = productByName.get(name);
    if (id === undefined) throw new Error(`Demo seed expected product "${name}"`);
    return id;
  };

  const ghacem = createSupplier(
    db,
    {
      name: 'Ghacem Depot, Tema',
      contactPerson: 'Mr Adjei',
      phone: '030 222 1100',
      address: 'Heavy Industrial Area, Tema',
    },
    actor,
  );
  const steelWorks = createSupplier(
    db,
    { name: 'Tema Steel Works', contactPerson: 'Hajia Fati', phone: '024 555 6677' },
    actor,
  );
  const pipesAndSheets = createSupplier(
    db,
    { name: 'Amasaman Pipes & Sheets', contactPerson: 'Selorm', phone: '027 909 1234' },
    actor,
  );
  db.update(suppliers).set({ isDemo: true }).run();

  // A truckload of cement, paid on delivery.
  createPurchase(
    db,
    {
      supplierId: ghacem,
      businessDate: daysBefore(today, 74),
      invoiceNo: 'GH-4471',
      items: [{ productId: need('Cement 50kg'), qty: u(600), unitCost: m(84) }],
      tenders: [{ paymentAccountId: bank.id, amount: m(50_400) }],
      isDemo: true,
    },
    actor,
  );

  // Steel, part paid. Leaves a payable, and the higher price re-averages the
  // cost of every rod already in the yard.
  createPurchase(
    db,
    {
      supplierId: steelWorks,
      businessDate: daysBefore(today, 46),
      invoiceNo: 'TSW-90233',
      items: [
        { productId: need('Iron rod 12mm'), qty: u(200), unitCost: m(99) },
        { productId: need('Iron rod 16mm'), qty: u(80), unitCost: m(178) },
      ],
      tenders: [{ paymentAccountId: bank.id, amount: m(20_000) }],
      note: 'Balance due end of month',
      isDemo: true,
    },
    actor,
  );

  // Entirely on credit.
  createPurchase(
    db,
    {
      supplierId: pipesAndSheets,
      businessDate: daysBefore(today, 17),
      invoiceNo: 'APS-1188',
      items: [
        { productId: need('PVC pipe 4in'), qty: u(60), unitCost: m(121) },
        { productId: need('PVC pipe 2in'), qty: u(80), unitCost: m(55) },
        { productId: need('Roofing sheet aluzinc 3m'), qty: u(90), unitCost: m(186) },
      ],
      invoiceDiscount: m(250),
      tenders: [],
      isDemo: true,
    },
    actor,
  );

  // A second cement load, after the price moved. Weighted average earns its
  // keep here: the yard now holds bags bought at two different prices.
  createPurchase(
    db,
    {
      supplierId: ghacem,
      businessDate: daysBefore(today, 9),
      invoiceNo: 'GH-4620',
      items: [{ productId: need('Cement 50kg'), qty: u(600), unitCost: m(89) }],
      tenders: [{ paymentAccountId: bank.id, amount: m(30_000) }],
      note: 'Balance on account',
      isDemo: true,
    },
    actor,
  );

  // A part payment against what is owed.
  recordSupplierPayment(
    db,
    {
      supplierId: steelWorks,
      businessDate: daysBefore(today, 20),
      paymentAccountId: momo.id,
      amount: m(6_000),
      reference: 'MM-8850119',
      isDemo: true,
    },
    actor,
  );

  db.update(purchases).set({ isDemo: true }).where(eq(purchases.isDemo, false)).run();
}
