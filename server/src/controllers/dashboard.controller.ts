import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function dashboardSummary(_req: Request, res: Response) {
  const PAPPU_OUTTURN = 0.6;
  const [
    pendingPOs,
    arrivedPOs,
    pendingSales,
    verifiedSeed,
    pappuDispatchedAgg,
    payableAgg,
  ] = await Promise.all([
    prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
    prisma.purchaseOrder.count({ where: { status: 'ARRIVED' } }),
    prisma.saleOrder.count({ where: { status: 'PENDING' } }),
    // All verified black seed received (one pool — milling does not deplete it).
    prisma.weightVerification.aggregate({ _sum: { finalWeightKg: true } }),
    // Pappu sold = all dispatched Pappu shipments (RVP kata weight), across every
    // dispatch (partial or full, delivered or not).
    prisma.saleDispatch.aggregate({
      _sum: { weightKg: true },
      where: { saleOrder: { product: 'PAPPU' } },
    }),
    // Total verified payable to suppliers (no Payment model yet — open question #6).
    prisma.weightVerification.aggregate({ _sum: { totalAmount: true } }),
  ]);

  const receivedSeedKg = verifiedSeed._sum.finalWeightKg ?? 0;
  const pappuDispatchedKg = pappuDispatchedAgg._sum.weightKg ?? 0;
  // Black seed is depleted only when pappu is sold: each kg sold used 1/0.6 kg seed.
  const blackStockOnHandKg = Math.max(0, receivedSeedKg - pappuDispatchedKg / PAPPU_OUTTURN);
  // Pappu produced is the derived potential of all received seed (60% out-turn).
  const pappuProducedKg = Math.round(receivedSeedKg * PAPPU_OUTTURN);
  const pappuInventoryKg = Math.max(0, pappuProducedKg - pappuDispatchedKg);
  const supplierPayable = Number(payableAgg._sum.totalAmount ?? 0);

  res.json({
    pendingPOs,
    arrivedPOs,
    pendingSales,
    blackStockOnHandKg,
    pappuProducedKg,
    pappuDispatchedKg,
    pappuInventoryKg,
    supplierPayable,
  });
}

export async function huskPnl(req: Request, res: Response) {
  try {
    const accounts = await prisma.account.findMany({
      where: { code: { in: ['40010', '50020', '50030', '50070', '50080', '50090'] } }
    });
    
    const accountMap = new Map(accounts.map(a => [a.code, a.id]));
    const idToCodeMap = new Map(accounts.map(a => [a.id, a.code]));

    const revAccountId = accountMap.get('40010');
    let huskRevenue = 0;

    if (revAccountId) {
      const huskRevenueLines = await prisma.journalLine.aggregate({
        _sum: { credit: true, debit: true },
        where: { accountId: revAccountId, costCenter: 'HUSK' },
      });
      huskRevenue = Number(huskRevenueLines._sum.credit ?? 0) - Number(huskRevenueLines._sum.debit ?? 0);
    }

    const expenseCodes = ['50020', '50030', '50070', '50080', '50090'];
    const expenseAccountIds = expenseCodes.map(c => accountMap.get(c)).filter(Boolean) as string[];

    let expenseLines: any[] = [];
    if (expenseAccountIds.length > 0) {
      expenseLines = await prisma.journalLine.groupBy({
        by: ['accountId'],
        _sum: { debit: true, credit: true },
        where: { accountId: { in: expenseAccountIds } },
      });
    }

    const expenses = {
      factoryLabor: 0,
      factoryOverhead: 0,
      loadingHamali: 0,
      interest: 0,
      transportInternal: 0,
      total: 0,
    };

    for (const row of expenseLines) {
      const code = idToCodeMap.get(row.accountId);
      const netExpense = Number(row._sum.debit ?? 0) - Number(row._sum.credit ?? 0);
      expenses.total += netExpense;
      if (code === '50020') expenses.factoryLabor += netExpense;
      else if (code === '50030') expenses.factoryOverhead += netExpense;
      else if (code === '50070') expenses.loadingHamali += netExpense;
      else if (code === '50080') expenses.interest += netExpense;
      else if (code === '50090') expenses.transportInternal += netExpense;
    }

    const netRecovery = huskRevenue - expenses.total;

    res.json({
      revenue: huskRevenue,
      expenses,
      netRecovery,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate Husk PnL' });
  }
}
