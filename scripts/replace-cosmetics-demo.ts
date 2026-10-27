/** Explicit development-only replacement; no backup is created. */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import type { Db } from '@/db/types';
import { configureConnection, assertDatabaseHealthy } from '@/db/pragmas';
import { env, assertDemoSeedAllowed } from '@/lib/env';
import { toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { fromUnits } from '@/domain/quantity';
import { createCategory, createProduct } from '@/services/catalog.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { createSale } from '@/services/sale.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { recordSupplierPayment } from '@/services/supplier-payment.service';
import { recordExpense, recordOwnerCapital } from '@/services/cashbook.service';
import { listExpenseCategories } from '@/services/payment-account.service';
import { createReconciliation, getReconciliationContext } from '@/services/reconciliation.service';
import { checkBooksIntegrity } from '@/services/reporting/ledger.service';
import { getProfitAndLoss } from '@/services/reporting/financial.service';
import { verifyAllStock, verifyBatchCoverage } from '@/services/inventory.service';
import { writeAudit } from '@/services/audit.service';

assertDemoSeedAllowed();
if (!process.argv.includes('--clear-all-without-backup')) {
  throw new Error('Requires --clear-all-without-backup; replaces ALL trading data, retaining users and settings.');
}
const connection = new Database(resolve(process.cwd(), env.DATABASE_PATH));
configureConnection(connection);
const db = drizzle(connection, { schema }) as Db;
const m = (value: number) => minor(Math.round(value * 100));
const today = toBusinessDate(new Date());
const date = (days: number) => {
  const value = new Date(`${today}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};
const catalog = [
  ['Face Care', 'Gentle Face Cleanser', 'Hydrating Face Wash', 'Micellar Cleansing Water', 'Exfoliating Face Scrub', 'Purifying Clay Mask'],
  ['Moisturisers', 'Daily Face Moisturiser', 'Night Repair Cream', 'Oil-Free Face Lotion', 'Hydrating Gel Cream', 'Nourishing Eye Cream'],
  ['Serums', 'Vitamin C Serum', 'Hyaluronic Acid Serum', 'Niacinamide Serum', 'Peptide Face Serum', 'Soothing Aloe Serum'],
  ['Sun Care', 'SPF 30 Face Sunscreen', 'SPF 50 Face Sunscreen', 'SPF 50 Body Sunscreen', 'After-Sun Aloe Gel', 'SPF 30 Lip Balm'],
  ['Body Care', 'Cocoa Butter Body Lotion', 'Shea Butter Body Cream', 'Refreshing Shower Gel', 'Nourishing Body Oil', 'Exfoliating Body Scrub'],
  ['Hair Care', 'Moisturising Shampoo', 'Repair Conditioner', 'Leave-In Conditioner', 'Deep Conditioning Mask', 'Argan Hair Oil'],
  ['Face Makeup', 'Liquid Foundation Honey', 'Liquid Foundation Cocoa', 'Concealer Warm Beige', 'Pressed Setting Powder', 'Blush Rose'],
  ['Eye Makeup', 'Black Lengthening Mascara', 'Black Liquid Eyeliner', 'Brown Brow Pencil', 'Neutral Eyeshadow Palette', 'Eye Makeup Remover'],
  ['Lip Products', 'Lipstick Ruby', 'Lipstick Nude', 'Clear Lip Gloss', 'Brown Lip Liner', 'Shea Lip Balm'],
  ['Fragrance & Nails', 'Floral Body Mist', 'Fresh Eau de Parfum', 'Nail Polish Red', 'Nail Polish Nude', 'Nail Polish Remover'],
];
// Children first; deferred FK checks also cover circular journal/document references.
const tradingTables = [
  'customer_payment_allocations', 'supplier_payment_allocations', 'sale_taxes', 'purchase_taxes',
  'stock_ledger_batches', 'quotation_items', 'sale_items', 'sale_payments', 'purchase_items',
  'purchase_payments', 'stock_adjustment_items', 'journal_lines', 'reconciliations',
  'year_end_closings', 'customer_payments', 'supplier_payments', 'expenses', 'incomes',
  'owner_movements', 'account_transfers', 'quotations', 'sales', 'purchases', 'stock_adjustments', 'stock_ledger',
  'product_batches', 'journal_entries', 'products', 'categories', 'customers', 'suppliers',
];

try {
  const result = connection.transaction(() => {
    const owner = db.select().from(schema.users).all().find(user => user.role === 'OWNER' && user.isActive);
    if (!owner) throw new Error('An active owner is required.');
    const settings = db.select().from(schema.businessSettings).get();
    if (settings?.taxEnabled || settings?.booksLockedBefore) {
      throw new Error('This fixture requires tax disabled and unlocked books; settings were not changed.');
    }
    const actor = { id: owner.id, username: owner.username };
    const accounts = db.select().from(schema.paymentAccounts).all().filter(account => account.isActive);
    const cash = accounts.find(account => account.kind === 'CASH');
    const bank = accounts.find(account => account.kind === 'BANK');
    const momo = accounts.find(account => account.kind === 'MOBILE_MONEY');
    if (!cash || !bank || !momo) throw new Error('Active cash, bank and mobile-money accounts are required.');
    connection.pragma('defer_foreign_keys = ON');
    for (const table of tradingTables) connection.exec(`DELETE FROM "${table}"`);

    const paymentAccounts = [cash, momo, bank];
    for (const [i, account] of paymentAccounts.entries()) {
      recordOwnerCapital(db, { businessDate: date(90), paymentAccountId: account.id,
        amount: m([10000, 8000, 40000][i]!), description: 'Cosmetics demo opening capital', isDemo: true }, actor);
    }
    const suppliers = ['Accra Beauty Wholesale (Demo)', 'Tema Cosmetics Depot (Demo)', 'Kumasi Personal Care Supply (Demo)']
      .map(name => createSupplier(db, { name }, actor));
    const customers = ['Abena Beauty Studio (Demo)', 'Akosua Cosmetics (Demo)', 'Esi Beauty Boutique (Demo)', 'Ama Salon (Demo)', 'Adwoa Beauty Shop (Demo)']
      .map(name => createCustomer(db, { name, creditLimit: null }, actor));
    db.update(schema.suppliers).set({ isDemo: true }).run();
    db.update(schema.customers).set({ isDemo: true }).run();
    const products: { id: number; cost: number; price: number }[] = [];
    for (const [groupIndex, group] of catalog.entries()) {
      const categoryId = createCategory(db, { name: group[0]! }, actor);
      for (const [itemIndex, name] of group.slice(1).entries()) {
        const cost = 18 + groupIndex * 6 + itemIndex * 3;
        const price = cost + 16 + groupIndex * 2;
        const id = createProduct(db, { name, sku: `COS-${String(products.length + 1).padStart(3, '0')}`,
          categoryId, unit: 'pcs', costPrice: m(cost), sellingPrice: m(price), minStock: fromUnits(25), trackInventory: true }, actor);
        products.push({ id, cost, price });
      }
    }
    db.update(schema.products).set({ isDemo: true }).run();
    db.update(schema.categories).set({ isDemo: true }).run();
    for (let i = 0; i < 10; i++) {
      const group = products.slice(i * 5, i * 5 + 5);
      const total = group.reduce((sum, product) => sum + product.cost * 30, 0);
      const credit = i % 3 === 0;
      const supplierId = suppliers[i % suppliers.length]!;
      const purchase = createPurchase(db, { supplierId, businessDate: date(89), invoiceNo: `DEMO-COS-${i + 1}`,
        items: group.map(product => ({ productId: product.id, qty: fromUnits(30), unitCost: m(product.cost) })),
        tenders: [{ paymentAccountId: bank.id, amount: m(credit ? total / 2 : total) }], isDemo: true }, actor);
      if (credit) recordSupplierPayment(db, { supplierId, businessDate: date(45), paymentAccountId: bank.id,
        amount: m(total / 4), allocations: [{ purchaseId: purchase.purchaseId, amount: m(total / 4) }], isDemo: true }, actor);
    }
    for (let i = 0; i < 100; i++) {
      const a = products[i % 50]!;
      const b = products[(i + 17) % 50]!;
      const units = 1 + i % 3;
      const total = a.price * units + b.price;
      const credit = i % 4 === 0;
      const customerId = customers[i % customers.length]!;
      const sale = createSale(db, { customerId, businessDate: date(88 - Math.floor(i * 88 / 99)), termsDays: 14,
        items: [{ productId: a.id, qty: fromUnits(units) }, { productId: b.id, qty: fromUnits(1) }],
        tenders: credit ? [] : [{ paymentAccountId: paymentAccounts[i % 3]!.id, amount: m(total) }], isDemo: true }, actor);
      if (credit && i % 8 === 0) recordCustomerPayment(db, { customerId, businessDate: date(0), paymentAccountId: momo.id,
        amount: minor(Math.floor(sale.total / 2)), allocations: [{ saleId: sale.saleId, amount: minor(Math.floor(sale.total / 2)) }], isDemo: true }, actor);
    }
    const expenseCategories = listExpenseCategories(db);
    if (!expenseCategories.length) throw new Error('No expense categories.');
    for (let i = 0; i < 12; i++) recordExpense(db, { businessDate: date(i * 7),
      categoryAccountId: expenseCategories.find(category => category.name === ['Rent', 'Transport', 'Electricity', 'Packaging'][i % 4])?.id
        ?? (() => { throw new Error('Required cosmetics expense category missing.'); })(),
      description: `Cosmetics demo: ${['shop rent', 'delivery charge', 'electricity', 'packaging'][i % 4]}`,
      amount: m([600, 80, 120, 65][i % 4]!), paymentAccountId: paymentAccounts[i % 3]!.id, isDemo: true }, actor);
    for (const account of paymentAccounts) {
      const context = getReconciliationContext(db, account.id, today);
      createReconciliation(db, { paymentAccountId: account.id, businessDate: today, actual: context.expected,
        adjust: false, explanation: 'Demo fixture count matching generated transactions', isDemo: true }, actor);
    }
    writeAudit(db, { userId: actor.id, username: actor.username, action: 'PURGE_DEMO', entityType: 'demo', entityId: 'cosmetics',
      summary: 'Replaced all trading data without backup with 50 cosmetics demo products and service-posted transactions.' });
    assertDatabaseHealthy(connection);
    const integrity = checkBooksIntegrity(db);
    if (!integrity.trialBalanced || !integrity.receivablesMatch || !integrity.payablesMatch || integrity.unbalancedEntries.length || integrity.untracedEntries) {
      throw new Error(`Books checks failed: ${JSON.stringify(integrity)}`);
    }
    if (verifyAllStock(db).some(row => !row.ok) || verifyBatchCoverage(db).some(row => !row.ok)) throw new Error('Stock verification failed.');
    if (products.length !== 50) throw new Error('Expected exactly 50 products.');
    return { products: products.length, sales: 100, purchases: 10, expenses: 12, customerPayments: 13, supplierPayments: 4,
      integrity, profitAndLoss: getProfitAndLoss(db, { from: date(90), to: today }) };
  }).immediate();
  console.log(JSON.stringify(result, null, 2));
} finally {
  connection.close();
}
