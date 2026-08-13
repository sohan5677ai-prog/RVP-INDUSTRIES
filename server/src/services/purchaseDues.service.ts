import { prisma } from '../lib/prisma.js';

/**
 * Server-side supplier-payables computation - the payable-side mirror of
 * computeBuyerDues() in salesDues.service.ts. Mirrors the "Net Outstanding
 * Dues" math on the Purchase Dues page (client/src/pages/PurchaseDues.tsx)
 * closely enough for the owner's daily digest: bills (verified grain
 * purchases + dust/byproduct purchases) are settled oldest-first against a
 * party's pooled SUPPLIER payments.
 *
 * Simplification vs. the page: the page also lets a payment target one
 * specific purchaseId directly (jumping the FIFO queue), which only matters
 * for exactly which bill shows as paid, not the totals - the sum of
 * outstanding amounts across a party's bills is the same either way, since a
 * payment is only ever applied within that party's own pool. Good enough for
 * a numeric summary; not used to drive any per-bill action.
 */

const TOLERANCE = 0.01;

export interface SupplierDuesPortfolio {
  totalBilling: number;
  totalPaid: number;
  totalPayable: number;
  pendingBillCount: number;
}

interface Bill {
  partyId: string;
  date: number;
  amount: number;
}

export async function computeSupplierDues(): Promise<SupplierDuesPortfolio> {
  const [purchases, dustPurchases, payments] = await Promise.all([
    prisma.purchase.findMany({
      where: { verification: { isNot: null } },
      select: {
        createdAt: true,
        stockIn: { select: { arrivalDate: true, purchaseOrder: { select: { partyId: true } } } },
        verification: { select: { totalAmount: true } },
      },
    }),
    prisma.dustPurchase.findMany({ select: { partyId: true, purchaseDate: true, amount: true } }),
    prisma.payment.findMany({ where: { type: 'SUPPLIER' }, select: { amount: true, partyId: true } }),
  ]);

  const bills: Bill[] = [];
  for (const p of purchases) {
    const partyId = p.stockIn?.purchaseOrder?.partyId;
    if (!partyId || !p.verification) continue;
    bills.push({
      partyId,
      date: (p.stockIn?.arrivalDate ?? p.createdAt).getTime(),
      amount: Math.round(Number(p.verification.totalAmount)),
    });
  }
  for (const d of dustPurchases) {
    bills.push({ partyId: d.partyId, date: d.purchaseDate.getTime(), amount: Math.round(Number(d.amount)) });
  }

  const paidByParty = new Map<string, number>();
  for (const pay of payments) {
    if (!pay.partyId) continue;
    paidByParty.set(pay.partyId, (paidByParty.get(pay.partyId) ?? 0) + Number(pay.amount));
  }

  const billsByParty = new Map<string, Bill[]>();
  for (const b of bills) {
    const arr = billsByParty.get(b.partyId) ?? [];
    arr.push(b);
    billsByParty.set(b.partyId, arr);
  }

  let totalBilling = 0;
  let totalPayable = 0;
  let pendingBillCount = 0;

  for (const [partyId, partyBills] of billsByParty) {
    partyBills.sort((a, b) => a.date - b.date);
    let paidPool = paidByParty.get(partyId) ?? 0;
    for (const bill of partyBills) {
      totalBilling += bill.amount;
      const applied = Math.min(paidPool, bill.amount);
      paidPool -= applied;
      const remaining = bill.amount - applied;
      if (remaining > TOLERANCE) pendingBillCount += 1;
      totalPayable += remaining;
    }
  }

  return {
    totalBilling: Math.round(totalBilling),
    totalPaid: Math.round(totalBilling - totalPayable),
    totalPayable: Math.round(totalPayable),
    pendingBillCount,
  };
}
