import type { Db } from '@/db/types';
import { customers, paymentAccounts, products, quotations } from '@/db/schema';
import {
  convertQuotation,
  createQuotation,
  cancelQuotation,
} from '@/services/quotation.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { addDays } from '@/domain/business-date';
import type { Actor } from '@/services/journal.service';

/**
 * Demo quotations: one in each state a yard's book actually holds.
 *
 * Written through the real service, like everything else here, so a converted
 * quote in the demo produces a genuine sale with genuine stock movements and a
 * balanced entry behind it. Nothing is inserted directly.
 *
 * The four cover what the screen has to be able to show: one still live, one
 * that quietly ran out, one that was won, and one that was lost. Without the
 * expired one there is nothing to try the override against, which is the part
 * of the feature most worth seeing before trusting it.
 */

const m = (cedis: number): Minor => minor(Math.round(cedis * 100));
const u = (units: number): Qty => fromUnits(units);

function daysBefore(businessDate: string, days: number): string {
  return addDays(businessDate, -days);
}

export function seedDemoQuotations(db: Db, actor: Actor, today: string): void {
  // Idempotent: never seed twice.
  if (db.select({ id: quotations.id }).from(quotations).limit(1).get()) return;

  const productByName = new Map(
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .all()
      .map((row) => [row.name, row.id]),
  );
  const need = (name: string): number => {
    const id = productByName.get(name);
    if (id === undefined) throw new Error(`Demo seed expected product "${name}"`);
    return id;
  };

  const customerByName = new Map(
    db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .all()
      .map((row) => [row.name, row.id]),
  );
  const bank = db
    .select()
    .from(paymentAccounts)
    .all()
    .find((account) => account.kind === 'BANK');
  if (!bank) return;

  // --- still live ---------------------------------------------------------
  createQuotation(
    db,
    {
      businessDate: daysBefore(today, 4),
      validUntil: addDays(today, 26),
      customerName: 'Adom Construction Ltd',
      customerId: customerByName.get('Adom Construction Ltd') ?? null,
      customerPhone: '024 111 2233',
      reference: 'Adenta site, phase 3',
      lines: [
        { productId: need('Cement 50kg'), qty: u(250), unitPrice: m(93) },
        { productId: need('Iron rod 12mm'), qty: u(80), unitPrice: m(108) },
        { productId: need('Binding wire'), qty: u(10) },
        { productId: need('Cartage to site'), qty: u(2) },
      ],
      quoteDiscount: m(500),
      notes: 'Price held for 30 days. Delivery within 48 hours of order.',
    },
    actor,
  );

  // --- quietly ran out ----------------------------------------------------
  //
  // The one worth having in a demo: it is what the "Ran out" filter finds, and
  // the only way to see the expiry override without waiting a month.
  createQuotation(
    db,
    {
      businessDate: daysBefore(today, 52),
      validUntil: daysBefore(today, 22),
      customerName: 'Kwame Boateng',
      customerPhone: '020 333 4455',
      reference: 'Tema Community 25',
      lines: [
        { productId: need('Roofing sheet aluzinc 3m'), qty: u(60) },
        { productId: need('Roofing nails 3in'), qty: u(15) },
      ],
      notes: 'Awaiting confirmation of roof measurements.',
    },
    actor,
  );

  // --- won ----------------------------------------------------------------
  const won = createQuotation(
    db,
    {
      businessDate: daysBefore(today, 34),
      validUntil: daysBefore(today, 4),
      customerName: 'Mensah & Sons Builders',
      customerId: customerByName.get('Mensah & Sons Builders') ?? null,
      customerPhone: '020 444 5566',
      reference: 'Kasoa site, plumbing',
      lines: [
        { productId: need('PVC pipe 4in'), qty: u(24), unitPrice: m(138) },
        { productId: need('PVC pipe 2in'), qty: u(30) },
        { productId: need('PVC elbow 4in'), qty: u(40) },
      ],
    },
    actor,
  );

  convertQuotation(
    db,
    won.quotationId,
    {
      businessDate: daysBefore(today, 30),
      customerId: customerByName.get('Mensah & Sons Builders') ?? null,
      tenders: [{ paymentAccountId: bank.id, amount: won.total }],
      isDemo: true,
    },
    actor,
  );

  // --- lost ---------------------------------------------------------------
  const lost = createQuotation(
    db,
    {
      businessDate: daysBefore(today, 26),
      validUntil: addDays(today, 4),
      customerName: 'Grace Ofori',
      customerPhone: '027 888 9900',
      reference: 'Oyarifa boundary wall',
      lines: [
        { productId: need('Cement 50kg'), qty: u(80) },
        { productId: need('Sand (tipper load)'), qty: u(1) },
      ],
    },
    actor,
  );
  cancelQuotation(db, lost.quotationId, 'Customer bought from another yard', actor);

  // Marked wholesale at the end, as the other demo seeds do. The sale behind
  // the converted quote is marked at its source — `convertQuotation` carries
  // `isDemo` through to the sale and its journal entry — because a sweep here
  // would reach the sale and miss the entry.
  db.update(quotations).set({ isDemo: true }).run();
}
