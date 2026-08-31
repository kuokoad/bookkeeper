import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { expenses, incomes, paymentAccounts } from '@/db/schema';
import { recordExpense, recordIncome, recordOwnerCapital } from '@/services/cashbook.service';
import {
  createReconciliation,
  getReconciliationContext,
} from '@/services/reconciliation.service';
import {
  listExpenseCategories,
  listIncomeCategories,
} from '@/services/payment-account.service';
import { minor, type Minor } from '@/domain/money';
import type { Actor } from '@/services/journal.service';

/**
 * Demo running costs and side income — the everyday things a corner shop pays
 * for. All recorded through the real service so the accounts and Profit & Loss
 * are genuinely derived, never faked.
 */

const m = (cedis: number): Minor => minor(Math.round(cedis * 100));

function daysBefore(businessDate: string, days: number): string {
  const [year, month, day] = businessDate.split('-').map(Number);
  const date = new Date(year ?? 2026, (month ?? 1) - 1, day ?? 1);
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function seedDemoCashbook(db: Db, actor: Actor, today: string): void {
  if (db.select({ id: expenses.id }).from(expenses).limit(1).get()) return;

  const accounts = db.select().from(paymentAccounts).all();
  const cash = accounts.find((account) => account.kind === 'CASH');
  const momo = accounts.find((account) => account.kind === 'MOBILE_MONEY');
  const bank = accounts.find((account) => account.kind === 'BANK');
  if (!cash || !momo || !bank) return;

  const expenseCategories = new Map(
    listExpenseCategories(db).map((category) => [category.name, category.id]),
  );
  const incomeCategories = new Map(
    listIncomeCategories(db).map((category) => [category.name, category.id]),
  );

  const expenseCategory = (name: string): number => {
    const id = expenseCategories.get(name);
    if (id === undefined) throw new Error(`Demo seed expected expense category "${name}"`);
    return id;
  };
  const incomeCategory = (name: string): number => {
    const id = incomeCategories.get(name);
    if (id === undefined) throw new Error(`Demo seed expected income category "${name}"`);
    return id;
  };

  const spend = (
    days: number,
    category: string,
    description: string,
    cedis: number,
    accountId: number,
    reference?: string,
  ) =>
    recordExpense(
      db,
      {
        businessDate: daysBefore(today, days),
        categoryAccountId: expenseCategory(category),
        description,
        amount: m(cedis),
        paymentAccountId: accountId,
        ...(reference ? { reference } : {}),
        isDemo: true,
      },
      actor,
    );

  // The owner's starting float. Without this the shop would appear to trade
  // from an impossible negative cash position — every real shop starts with
  // money the owner put in.
  const startingFloat = (accountId: number, cedis: number, what: string) =>
    recordOwnerCapital(
      db,
      {
        businessDate: daysBefore(today, 7),
        paymentAccountId: accountId,
        amount: m(cedis),
        description: what,
        isDemo: true,
      },
      actor,
    );

  // A yard carries far more float than a corner shop: it pays for truckloads.
  startingFloat(cash.id, 8_000, 'Owner opening cash float');
  startingFloat(momo.id, 2_000, 'Owner opening MoMo balance');
  startingFloat(bank.id, 60_000, 'Owner opening bank balance');

  spend(68, 'Rent', 'Yard rent for the month', 2_400, bank.id);
  spend(60, 'Transport', 'Tipper hire, Adenta delivery', 900, cash.id);
  spend(52, 'Staff Wages', 'Yard hands — monthly wages', 3_200, cash.id);
  spend(38, 'Rent', 'Yard rent for the month', 2_400, bank.id);
  spend(31, 'Electricity', 'ECG prepaid top-up', 380, momo.id, 'MM-8811023');
  spend(24, 'Transport', 'Forklift diesel', 640, cash.id);
  spend(19, 'Staff Wages', 'Yard hands — monthly wages', 3_200, cash.id);
  spend(11, 'MoMo Charges', 'Withdrawal charges', 42, momo.id);
  spend(7, 'Rent', 'Yard rent for the month', 2_400, bank.id);
  spend(4, 'Internet & Airtime', 'Airtime for the yard line', 60, momo.id, 'MM-8839912');
  spend(1, 'Transport', 'Tipper hire, Kasoa delivery', 750, cash.id);

  recordIncome(
    db,
    {
      businessDate: daysBefore(today, 33),
      categoryAccountId: incomeCategory('Commission'),
      description: 'Weighbridge fee recovered',
      amount: m(150),
      paymentAccountId: momo.id,
      reference: 'MM-8820447',
      isDemo: true,
    },
    actor,
  );

  recordIncome(
    db,
    {
      businessDate: daysBefore(today, 1),
      categoryAccountId: incomeCategory('Service Income'),
      description: 'Offloading charged to a customer',
      amount: m(300),
      paymentAccountId: cash.id,
      isDemo: true,
    },
    actor,
  );

  db.update(expenses).set({ isDemo: true }).where(eq(expenses.isDemo, false)).run();
  db.update(incomes).set({ isDemo: true }).where(eq(incomes.isDemo, false)).run();

  // An end-of-day cash count that came up a little short — the everyday case
  // this feature exists for. Recorded, explained and adjusted, so the shortage
  // is visible in the accounts rather than quietly absorbed.
  const cashContext = getReconciliationContext(db, cash.id, daysBefore(today, 1));
  createReconciliation(
    db,
    {
      paymentAccountId: cash.id,
      businessDate: daysBefore(today, 1),
      actual: minor((cashContext.expected as number) - 350),
      explanation: 'Short by GHS 3.50 — likely wrong change during the evening rush',
      adjust: true,
      isDemo: true,
    },
    actor,
  );

  // A MoMo count that agreed exactly.
  const momoContext = getReconciliationContext(db, momo.id, daysBefore(today, 1));
  createReconciliation(
    db,
    {
      paymentAccountId: momo.id,
      businessDate: daysBefore(today, 1),
      actual: momoContext.expected,
      adjust: true,
      isDemo: true,
    },
    actor,
  );
}
