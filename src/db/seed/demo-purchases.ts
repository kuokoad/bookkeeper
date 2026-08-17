import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { paymentAccounts, products, purchases, suppliers } from '@/db/schema';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { recordSupplierPayment } from '@/services/supplier-payment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, parseQty, type Qty } from '@/domain/quantity';
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

  const kasapreko = createSupplier(
    db,
    {
      name: 'Kasapreko Distributors',
      contactPerson: 'Mr Adjei',
      phone: '030 222 1100',
      address: 'Spintex Road, Accra',
    },
    actor,
  );
  const marketWholesale = createSupplier(
    db,
    { name: 'Madina Market Wholesale', contactPerson: 'Hajia Fati', phone: '024 555 6677' },
    actor,
  );
  const nestle = createSupplier(
    db,
    { name: 'Nestlé Ghana Agent', contactPerson: 'Selorm', phone: '027 909 1234' },
    actor,
  );
  db.update(suppliers).set({ isDemo: true }).run();

  // Paid in full on delivery.
  createPurchase(
    db,
    {
      supplierId: kasapreko,
      businessDate: daysBefore(today, 5),
      invoiceNo: 'KD-4471',
      items: [
        { productId: need('Coca-Cola 350ml'), qty: u(48), unitCost: m(4.6) },
        { productId: need('Bottled Water 750ml'), qty: u(60), unitCost: m(1.85) },
      ],
      tenders: [{ paymentAccountId: cash.id, amount: m(331.8) }],
      isDemo: true,
    },
    actor,
  );

  // Part paid — leaves a payable, and the higher price re-averages the cost.
  createPurchase(
    db,
    {
      supplierId: nestle,
      businessDate: daysBefore(today, 4),
      invoiceNo: 'NG-90233',
      items: [
        { productId: need('Milo Tin 400g'), qty: u(12), unitCost: m(39.5) },
        { productId: need('Evaporated Milk 170g'), qty: u(24), unitCost: m(6.8) },
      ],
      tenders: [{ paymentAccountId: bank.id, amount: m(300) }],
      note: 'Balance due end of month',
      isDemo: true,
    },
    actor,
  );

  // Entirely on credit.
  createPurchase(
    db,
    {
      supplierId: marketWholesale,
      businessDate: daysBefore(today, 2),
      invoiceNo: 'MW-1188',
      items: [
        { productId: need('Rice (local)'), qty: parseQty('50'), unitCost: m(13.5) },
        { productId: need('Key Soap'), qty: u(24), unitCost: m(4.1) },
        { productId: need('Groundnuts 100g'), qty: u(40), unitCost: m(2.4) },
      ],
      invoiceDiscount: m(15),
      tenders: [],
      isDemo: true,
    },
    actor,
  );

  // A part payment against what is owed.
  recordSupplierPayment(
    db,
    {
      supplierId: nestle,
      businessDate: today,
      paymentAccountId: momo.id,
      amount: m(100),
      reference: 'MM-8850119',
      isDemo: true,
    },
    actor,
  );

  db.update(purchases).set({ isDemo: true }).where(eq(purchases.isDemo, false)).run();
}
