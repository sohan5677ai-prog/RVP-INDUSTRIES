import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { getHamaliRateFull, getCustomHamaliRates } from './settings.controller.js';
import { customLoadingHamali, calcKataFee, isVehicleExempt } from '../lib/calc.js';

import { computeUnifiedStockEngine } from '../services/stockEngine.js';

export async function dashboardSummary(_req: Request, res: Response) {
  const PAPPU_OUTTURN = 0.6;
  
  const { bands, totalStorageKg, totalAllocatedPappuKg } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');

  const [
    pendingPOs,
    arrivedPOs,
    pendingSales,
    pappuDispatchedAgg,
    payableAgg,
  ] = await Promise.all([
    prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
    prisma.purchaseOrder.count({ where: { status: 'ARRIVED' } }),
    prisma.saleOrder.count({ where: { status: 'PENDING' } }),
    prisma.saleDispatch.aggregate({
      _sum: { weightKg: true },
      where: { saleOrder: { product: 'PAPPU' } },
    }),
    prisma.weightVerification.aggregate({ _sum: { totalAmount: true } }),
  ]);

  const pappuDispatchedKg = pappuDispatchedAgg._sum.weightKg ?? 0;
  
  // Total arrived seed = RVP seed + Storage seed.
  // The bands.arrivedBlackKg includes the total gross arrived at RVP (including transfers).
  const grossArrivedRvpKg = bands.reduce((s, b) => s + b.arrivedBlackKg, 0);
  const receivedSeedKg = grossArrivedRvpKg + totalStorageKg;

  // Black seed is depleted only when pappu is sold: each kg sold used 1/0.6 kg seed.
  // RVP remaining is given by the engine, plus un-transferred storage.
  const remainingRvpKg = bands.reduce((s, b) => s + (b.remainingBlackKg ?? 0), 0);
  const blackStockOnHandKg = Math.max(0, remainingRvpKg + totalStorageKg);

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

// Non-pappu byproduct revenue pooled into the "Husk" recovery view. Excludes
// Pappu (its own P&L) and Shell.
const POOL_REVENUE_COST_CENTERS = [
  'HUSK', 'WASTE', 'TPS', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU',
];
// Products loaded at the ₹/tonne WASTE_LOADING rate (10% pool byproducts).
const WASTE_LOADING_PRODUCTS = new Set([
  'WASTE', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU',
]);

// "RVP" is the company's own-orders marker (not a real commission agent).
const isOwnBroker = (name?: string | null) => (name ?? '').trim().toUpperCase() === 'RVP';

/**
 * Husk (byproduct) recovery pool for the dashboard. Pools all non-pappu byproduct
 * SALE revenue and deducts every operating cost, itemized. This is a MANAGEMENT
 * view - loading-hamali lines are recomputed from current ₹/tonne rates × dispatched
 * tonnage (so "Pappu Roasting" separates from "Pappu Loading", which the ledger
 * merges), and the four standalone reports (gunny/electricity/maintenance/drawings)
 * are read from their own tables. Nothing here is posted to the accounting ledger.
 */
export interface HuskExpenses {
  blackSeedUnloading: number;
  transferHamali: number;
  transferTransport: number;
  saleFreight: number;
  pappuShortage: number;
  huskShortage: number;
  creditNotes: number;
  pappuLoading: number;
  pappuRoasting: number;
  huskLoading: number;
  tWasteLoading: number;
  bagCutting: number;
  pappuNet: number;
  tpsBrokensPacking: number;
  tamarindByproductsPacking: number;
  tarbalFee: number;
  misc: number;
  gunnyBags: number;
  electricity: number;
  maintenance: number;
  miscExpense: number;
  subscription: number;
  storageElectricity: number;
  storageSalaries: number;
  drawingsShabri: number;
  drawingsReddy: number;
  ccInterest: number;
  termLoanInterest: number;
  loanInterestUnabsorbed: number;
  termLoanPrincipal: number;
  brokerage: number;
}

// Map frontend expense labels to their exact backend keys. Also flag the
// pappu-flagged ones so Net Profit does not double-count them.
export const HUSK_EXPENSE_META: { key: keyof HuskExpenses; label: string; pappu: boolean }[] = [
  { key: 'blackSeedUnloading', label: 'Black Seed Unloading', pappu: false },
  { key: 'transferHamali',     label: 'Byproduct Transfer Hamali', pappu: false },
  { key: 'transferTransport',  label: 'Byproduct Transfer Transport', pappu: false },
  { key: 'saleFreight',        label: 'Husk Sale Freight', pappu: false },
  { key: 'pappuShortage',      label: 'Pappu Shortage',       pappu: true  },
  { key: 'huskShortage',       label: 'Husk Shortage',        pappu: false },
  { key: 'creditNotes',        label: 'Credit Notes',         pappu: false },
  { key: 'pappuLoading',       label: 'Pappu Loading',        pappu: true  },
  { key: 'pappuRoasting',      label: 'Pappu Roasting',       pappu: true  },
  { key: 'huskLoading',        label: 'Husk Loading',         pappu: false },
  { key: 'tWasteLoading',      label: 'T-Waste Loading',      pappu: false },
  { key: 'bagCutting',         label: 'Bag Cutting',          pappu: false },
  { key: 'pappuNet',           label: 'Pappu Net (Rasi)',     pappu: true  },
  { key: 'tpsBrokensPacking',  label: 'TPS Brokens Packing',  pappu: false },
  { key: 'tamarindByproductsPacking', label: 'Tamarind Byproducts Packing', pappu: false },
  { key: 'tarbalFee',          label: 'Tarbal Fee',           pappu: false },
  // Hamali-crew MISC charges. Distinct from `miscExpense` below, which is the
  // Expenses > Miscellaneous tab - hence the qualified label.
  { key: 'misc',               label: 'Hamali Miscellaneous', pappu: false },
  { key: 'gunnyBags',          label: 'Gunny Bags (purchases)', pappu: false },
  { key: 'electricity',        label: 'Electricity',          pappu: false },
  { key: 'maintenance',        label: 'Maintenance',          pappu: false },
  { key: 'miscExpense',        label: 'Miscellaneous Expenses', pappu: false },
  { key: 'subscription',       label: 'Subscription',         pappu: false },
  { key: 'storageElectricity', label: 'Storage Electricity',  pappu: false },
  { key: 'storageSalaries',    label: 'Storage Salaries',     pappu: false },
  { key: 'drawingsShabri',     label: 'Drawings - Shabri',    pappu: false },
  { key: 'drawingsReddy',      label: 'Drawings - Reddy',     pappu: false },
  { key: 'ccInterest',         label: 'CC Interest',          pappu: false },
  { key: 'termLoanInterest',   label: 'Term Loan Interest',   pappu: false },
  { key: 'loanInterestUnabsorbed', label: 'Loan Interest (unabsorbed)', pappu: false },
  { key: 'termLoanPrincipal',  label: 'Term Loan Principal',  pappu: false },
  { key: 'brokerage',          label: 'Brokerage',            pappu: false },
];

// Husk-pool INCOME lines (Income tab): each is added on top of the pooled
// byproduct revenue, in both the dashboard recovery card and the P&L husk pool.
export interface HuskIncome {
  kataIncome: number;
  hamaliCompanyProfit: number;
  gunnySales: number;
  otherIncome: number;
  interestIncome: number;
}

export const HUSK_INCOME_META: { key: keyof HuskIncome; label: string }[] = [
  { key: 'kataIncome',          label: 'Kata Income' },
  { key: 'hamaliCompanyProfit', label: 'Hamali Company Profit' },
  { key: 'gunnySales',          label: 'Gunny Bag Sales' },
  { key: 'otherIncome',         label: 'Other Income' },
  { key: 'interestIncome',      label: 'Interest Income (Private Loans)' },
];

// Shared husk-pool computation: pooled byproduct revenue + every operating cost,
// itemized. Loading-hamali lines are recomputed from current ₹/tonne rates ×
// dispatched tonnage; the four standalone reports (gunny/electricity/maintenance/
// drawings) are read from their own tables. Used by the dashboard recovery card
// and by the P&L page's husk pool.
export async function computeHuskPool(): Promise<{ revenue: number; expenses: HuskExpenses; income: HuskIncome }> {
  const [
    byproductDispatches,
    freightOutwardAccount,
    hamaliIncomeAccount,
    dispatches,
    blackSeedHamali,
    manualByType,
    gunnyByDir,
    electricityAgg,
    maintenanceAgg,
    miscExpenseAgg,
    subscriptionAgg,
    storageByKind,
    drawingsByOwner,
    interestByType,
    pappuRate,
    huskRate,
    wasteRate,
    customRates,
    shellAgg,
    huskAgg,
    termLoanPrincipalAgg,
    interestCapitalisedAgg,
    interestPaidAgg,
    otherIncomeAgg,
    gunnySalesAgg,
    privateLoanInterestAgg,
    brokerageDispatches,
    lockedShortageReceipts,
    issuedCreditNotes,
    purchaseKataAgg,
    dustPurchasesForKata,
    saleDispatchesForKata,
    stockTransfersForKata,
    shellTransfersForKata,
    huskTransfersForKata,
    companyProfile,
  ] = await Promise.all([
      prisma.saleDispatch.findMany({
        where: { saleOrder: { product: { in: POOL_REVENUE_COST_CENTERS as any } } },
        select: {
          weightKg: true,
          gstAmount: true,
          saleOrder: { select: { ratePerKg: true } },
        },
      }),
      prisma.account.findUnique({ where: { code: '50050' }, select: { id: true } }),
      prisma.account.findUnique({ where: { code: '40030' }, select: { id: true } }),
      prisma.$queryRaw<{product: string, weightKg: bigint}[]>`
        SELECT so."product", SUM(sd."weightKg") as "weightKg"
        FROM "SaleOrder" so
        JOIN "SaleDispatch" sd ON sd."saleOrderId" = so.id
        GROUP BY so."product"
      `,
      prisma.purchase.aggregate({ _sum: { hamaliCharge: true } }),
      (prisma.manualHamaliCost.groupBy as any)({ by: ['type'], _sum: { amount: true } }),
      // Purchases (debit) vs sales (credit); PAYMENT rows don't affect husk cost.
      // Read rows, not an aggregate: legacy entries have debit/credit = 0 and carry
      // the value in the old `amount`/`direction` pair, exactly as the Feroz Ledger
      // page falls back. Aggregating `debit` alone silently drops them.
      prisma.gunnyBagEntry.findMany({ select: { type: true, direction: true, debit: true, credit: true, amount: true } }),
      prisma.electricityBill.aggregate({ _sum: { amount: true } }),
      prisma.maintenanceExpense.aggregate({ _sum: { amount: true } }),
      prisma.miscExpense.aggregate({ _sum: { amount: true } }),
      prisma.subscriptionCharge.aggregate({ _sum: { amount: true } }),
      (prisma.storageMaintenanceExpense.groupBy as any)({ by: ['kind'], _sum: { amount: true } }),
      (prisma.drawing.groupBy as any)({ by: ['owner'], _sum: { amount: true } }),
      (prisma.interestCharge.groupBy as any)({ by: ['type'], _sum: { amount: true } }),
      getHamaliRateFull('PAPPU_LOADING'),
      getHamaliRateFull('HUSK_LOADING'),
      getHamaliRateFull('WASTE_LOADING'),
      getCustomHamaliRates(),
      prisma.shellTransfer.aggregate({ _sum: { transportCharge: true, hamaliCharge: true } }),
      prisma.huskTransfer.aggregate({ _sum: { transportCharge: true, hamaliCharge: true } }),
      prisma.termLoanPrincipal.aggregate({ _sum: { amount: true } }),
      // Storage-loan carrying interest: capitalised onto transferred seed vs
      // actually paid to the bank at repayment (see loan reconciliation).
      prisma.stockTransfer.aggregate({ _sum: { interestCharge: true } }),
      prisma.loanRepayment.aggregate({ _sum: { interest: true } }),
      // ── Income-tab sources (Kata Income / Hamali Company Profit / Other Income / Gunny Sales) ──
      prisma.otherIncomeEntry.aggregate({ _sum: { amount: true } }),
      prisma.gunnySaleEntry.aggregate({ _sum: { amount: true } }),
      // Interest actually received on private loans given out (booked to 40130
      // the moment a repayment is recorded - see LedgerService.postPrivateLoanRepayment).
      prisma.privateLoanRepayment.aggregate({ _sum: { interest: true } }),
      // Per-broker flat brokerage per dispatch, RVP (own orders) excluded - mirrors
      // the Brokerage Ledger/Dues reports exactly, so it only lands here once a
      // shipment actually dispatches (not at order-booking time).
      prisma.saleDispatch.findMany({
        where: { saleOrder: { brokerId: { not: null } } },
        select: { saleOrder: { select: { broker: { select: { name: true, brokerageAmount: true } } } } },
      }),
      // LOCKED weight shortages. A buyer's kata slip at delivery only ESTIMATES a
      // shortage - we learn whether they actually cut it when the money arrives, so
      // the deduction booked on the receipt is the real cost. GST-inclusive on
      // purpose: no credit note goes to the department, so the 5% is lost too.
      prisma.receipt.findMany({
        where: { type: 'BUYER', shortageAmount: { gt: 0 }, saleDispatchId: { not: null } },
        select: {
          shortageAmount: true,
          saleDispatch: { select: { saleOrder: { select: { product: true } } } },
        },
      }),
      // ISSUED credit notes - to capture manual/quality deductions while avoiding
      // double-counting formal shortage credit notes whose dispatches already booked
      // receipt shortages.
      prisma.creditNote.findMany({
        where: { status: 'ISSUED' },
        select: {
          id: true,
          taxableValue: true,
          totalAmount: true,
          saleDispatchId: true,
          saleDispatch: {
            select: {
              receipts: {
                where: { shortageAmount: { gt: 0 } },
                select: { id: true },
              },
            },
          },
        },
      }),
      prisma.purchase.aggregate({ _sum: { kataFee: true } }),
      prisma.dustPurchase.findMany({ select: { weightKg: true, lorryNumber: true } }),
      prisma.saleDispatch.findMany({ select: { weightKg: true, vehicleNumber: true } }),
      prisma.stockTransfer.findMany({ select: { weightKg: true, lorryNumber: true } }),
      prisma.shellTransfer.findMany({ select: { weightKg: true, lorryNumber: true } }),
      prisma.huskTransfer.findMany({ select: { weightKg: true, lorryNumber: true } }),
      prisma.companyProfile.findFirst({ select: { companyVehicles: true } }),
    ]);

    // ── Revenue: pooled byproduct sales revenue (GST-inclusive dispatched sales) ──
    const revenue = Math.round(
      byproductDispatches.reduce(
        (sum, d) => sum + d.weightKg * Number(d.saleOrder.ratePerKg) + Number(d.gstAmount || 0),
        0,
      ) * 100,
    ) / 100;

    // ── Outward freight on DELIVERY-priced byproduct sales ──────────────────────
    // Husk & co. are normally quoted BASE (ex-works, on the buyer's lorry), which
    // posts no freight at all. When a buyer takes them at a delivery price the
    // quoted rate INCLUDES the freight, so the revenue credited above is inflated
    // by exactly the freight we then pay the lorry. Netting it here is what makes
    // the pool's byproduct income a real after-freight figure.
    //
    // Cost-centre filtered to the pool products on purpose: Pappu's freight also
    // lands on 50050 but is already deducted inside the Pappu P/L, so pulling the
    // whole account in would double-count it.
    let saleFreight = 0;
    if (freightOutwardAccount) {
      const freightLines = await prisma.journalLine.aggregate({
        _sum: { debit: true, credit: true },
        where: { accountId: freightOutwardAccount.id, costCenter: { in: POOL_REVENUE_COST_CENTERS } },
      });
      saleFreight = Number(freightLines._sum.debit ?? 0) - Number(freightLines._sum.credit ?? 0);
    }

    // ── Dispatched tonnage per product (drives recomputed loading hamali) ───────
    let pappuKg = 0, huskKg = 0, wasteKg = 0;
    for (const d of dispatches) {
      const product = d.product;
      const weight = Number(d.weightKg || 0);
      if (product === 'PAPPU') pappuKg += weight;
      else if (product === 'HUSK') huskKg += weight;
      else if (WASTE_LOADING_PRODUCTS.has(product)) wasteKg += weight;
    }

    const pappuLoading = customLoadingHamali(pappuKg, pappuRate.total, pappuRate.lorry, pappuRate.margin).company;
    const pappuRoasting = customRates.reduce(
      (s, c) => s + customLoadingHamali(pappuKg, c.total, c.lorry, c.margin).company, 0,
    );
    const huskLoading = customLoadingHamali(huskKg, huskRate.total, huskRate.lorry, huskRate.margin).company;
    const tWasteLoading = customLoadingHamali(wasteKg, wasteRate.total, wasteRate.lorry, wasteRate.margin).company;

    // ── Manual hamali costs grouped by type ─────────────────────────────────────
    const manual = Object.fromEntries(
      (manualByType as any[]).map((r) => [r.type, Number(r._sum.amount ?? 0)]),
    );
    const bagCutting = (manual['BAG_CUTTING_NORMAL'] ?? 0) + (manual['BAG_CUTTING_DISTANCE'] ?? 0);
    const pappuNet = manual['PAPPU_NET'] ?? 0;
    const tpsBrokensPacking = manual['TPS_BROKENS_PACKING'] ?? 0;
    const tamarindByproductsPacking = manual['TAMARIND_BYPRODUCTS_PACKING'] ?? 0;
    const tarbalFee = manual['TARBAL_FEE'] ?? 0;
    const misc = manual['MISC'] ?? 0;
    // NOTE: PAID entries settle the 20200 hamali payable (Dr payable / Cr cash) -
    // they are not an operating expense, so they are deliberately not summed here.

    // ── Static/Standalone Expenses ──────────
    // Byproduct (shell/husk) transfer costs ONLY. The black-seed StockTransfer
    // hamali + transport are deliberately EXCLUDED here: they are capitalised into
    // the seed's landed value (movedValue) and so are already inside the Pappu P/L
    // via COGS. Adding them here too would double-count them. Byproduct income in
    // this pool is gross revenue with no COGS, so shell/husk transfer costs are a
    // real net cost counted exactly once. (Same logic as loanInterestUnabsorbed.)
    const transferHamali =
      Number(shellAgg._sum.hamaliCharge || 0) +
      Number(huskAgg._sum.hamaliCharge || 0);

    const transferTransport =
      Number(shellAgg._sum.transportCharge || 0) +
      Number(huskAgg._sum.transportCharge || 0);

    // Purchases on Feroz Ledger are a husk-pool cost; standalone gunny sales in Income tab are income
    const gunnyBags = gunnyByDir.reduce((s, r) => {
      const debit = Number(r.debit ?? 0);
      const credit = Number(r.credit ?? 0);
      // Legacy row: both columns 0, value lives in `amount` keyed by `direction`.
      if (debit === 0 && credit === 0 && r.direction === 'PURCHASE') return s + Number(r.amount ?? 0);
      return s + debit;
    }, 0);
    const gunnySales = Number(gunnySalesAgg._sum.amount ?? 0);
    const electricity = Number(electricityAgg._sum.amount ?? 0);
    const maintenance = Number(maintenanceAgg._sum.amount ?? 0);
    const miscExpense = Number(miscExpenseAgg._sum.amount ?? 0);
    const subscription = Number(subscriptionAgg._sum.amount ?? 0);
    const storage = Object.fromEntries(
      (storageByKind as any[]).map((r) => [r.kind, Number(r._sum.amount ?? 0)]),
    );
    const storageElectricity = storage['ELECTRICITY'] ?? 0;
    const storageSalaries = storage['SALARY'] ?? 0;
    const drawings = Object.fromEntries(
      (drawingsByOwner as any[]).map((r) => [r.owner, Number(r._sum.amount ?? 0)]),
    );
    const interest = Object.fromEntries(
      (interestByType as any[]).map((r) => [r.type, Number(r._sum.amount ?? 0)]),
    );

    // Storage-loan interest sweep: interest actually PAID to the bank is the real
    // cash cost; the slice CAPITALISED onto transferred seed is already recovered
    // through Pappu COGS. What is left over — paid − capitalised — is the
    // UNABSORBED financing cost and is a genuine husk-pool expense, so it must be
    // a POSITIVE number here (every husk expense line is subtracted from the pool).
    // Clamped at zero: once capitalised interest overtakes what we have paid the
    // bank, nothing is unabsorbed — the excess is a still-owed accrual sitting on
    // 20280, not husk-pool income, so it must never credit the pool.
    const interestCapitalised = Number(interestCapitalisedAgg._sum.interestCharge ?? 0);
    const interestPaidToBank = Number(interestPaidAgg._sum.interest ?? 0);
    const loanInterestUnabsorbed = Math.max(
      0,
      Math.round((interestPaidToBank - interestCapitalised) * 100) / 100,
    );

    // Brokerage: each broker's own flat rate per dispatched shipment whose
    // order has a real (non-RVP) broker - mirrors the Brokerage Ledger/Dues
    // reports exactly.
    const brokerage = brokerageDispatches
      .filter((d) => !isOwnBroker(d.saleOrder.broker?.name))
      .reduce((sum, d) => sum + Number(d.saleOrder.broker?.brokerageAmount ?? 0), 0);

    // Locked shortages split into the two lines the business tracks: Pappu, and
    // everything else pooled as Husk. Neither is netted anywhere else - the Pappu
    // margin bills the full ordered tonnage and the pool's byproduct income is
    // gross dispatched value - so counting them here is the only time they land.
    let pappuShortage = 0;
    let huskShortage = 0;
    for (const r of lockedShortageReceipts) {
      const amount = Number(r.shortageAmount ?? 0);
      if (r.saleDispatch?.saleOrder.product === 'PAPPU') pappuShortage += amount;
      else huskShortage += amount;
    }

    // Manual credit notes (e.g. quality shortfalls, price corrections, trade
    // discounts). A credit note whose dispatch matches a receipt that already
    // booked a shortage is the formal document for that same shortage (counted in
    // pappuShortage / huskShortage above) - we exclude it to avoid double-counting.
    // Notes for dispatches with no receipt shortage and standalone notes are
    // genuine additional deductions.
    let creditNotesTotal = 0;
    for (const cn of issuedCreditNotes) {
      const hasReceiptShortage = (cn.saleDispatch?.receipts?.length ?? 0) > 0;
      if (hasReceiptShortage) continue;
      creditNotesTotal += Number(cn.totalAmount || cn.taxableValue || 0);
    }

    const expenses: HuskExpenses = {
      blackSeedUnloading: Number(blackSeedHamali._sum.hamaliCharge ?? 0),
      transferHamali,
      transferTransport,
      saleFreight,
      pappuShortage: Math.round(pappuShortage * 100) / 100,
      huskShortage: Math.round(huskShortage * 100) / 100,
      creditNotes: Math.round(creditNotesTotal * 100) / 100,
      pappuLoading,
      pappuRoasting,
      huskLoading,
      tWasteLoading,
      bagCutting,
      pappuNet,
      tpsBrokensPacking,
      tamarindByproductsPacking,
      tarbalFee,
      misc,
      gunnyBags,
      electricity,
      maintenance,
      miscExpense,
      subscription,
      storageElectricity,
      storageSalaries,
      drawingsShabri: drawings['SHABRI'] ?? 0,
      drawingsReddy: drawings['REDDY'] ?? 0,
      ccInterest: interest['CC'] ?? 0,
      termLoanInterest: interest['TERM_LOAN'] ?? 0,
      loanInterestUnabsorbed,
      termLoanPrincipal: Number(termLoanPrincipalAgg._sum.amount ?? 0),
      brokerage,
    };

    // ── Hamali Company Profit: every hamali margin (purchase unloading + sale
    // loading + stock-transfer legs) posts to GL 40030 "Hamali Income" at the
    // moment it's booked (see ledger.service.ts). Summing that account directly
    // is exact and avoids re-deriving the per-row margin split here.
    let hamaliCompanyProfit = 0;
    if (hamaliIncomeAccount) {
      const hamaliLines = await prisma.journalLine.aggregate({
        _sum: { credit: true, debit: true },
        where: { accountId: hamaliIncomeAccount.id },
      });
      hamaliCompanyProfit = Number(hamaliLines._sum.credit ?? 0) - Number(hamaliLines._sum.debit ?? 0);
    }

    // ── Kata Income: the weighbridge fee collected across every lorry (purchase,
    // dust buy, sale freight, byproduct transfer) - mirrors the Kata Report ledger.
    // Purchase.kataFee is already exemption-aware (computed at StockIn time); the
    // rest are recomputed the same way the Kata Report does client-side.
    const companyVehicles = companyProfile?.companyVehicles;
    const exempt = (lorry: string | null | undefined) => isVehicleExempt(lorry, companyVehicles);
    const purchaseKata = Number(purchaseKataAgg._sum.kataFee ?? 0);
    const dustKata = dustPurchasesForKata.reduce((s, d) => s + calcKataFee(d.weightKg, exempt(d.lorryNumber)), 0);
    const saleKata = saleDispatchesForKata.reduce((s, d) => s + calcKataFee(d.weightKg, exempt(d.vehicleNumber)), 0);
    const transferKata =
      stockTransfersForKata.reduce((s, t) => s + calcKataFee(t.weightKg, exempt(t.lorryNumber)), 0) +
      shellTransfersForKata.reduce((s, t) => s + calcKataFee(t.weightKg, exempt(t.lorryNumber)), 0) +
      huskTransfersForKata.reduce((s, t) => s + calcKataFee(t.weightKg, exempt(t.lorryNumber)), 0);
    const kataIncome = purchaseKata + dustKata + saleKata + transferKata;

    const income: HuskIncome = {
      kataIncome,
      hamaliCompanyProfit,
      gunnySales,
      otherIncome: Number(otherIncomeAgg._sum.amount ?? 0),
      interestIncome: Number(privateLoanInterestAgg._sum.interest ?? 0),
    };

  return { revenue, expenses, income };
}

// Dashboard husk-recovery card: full itemized pool (includes pappu-flagged costs).
export async function huskPnl(_req: Request, res: Response) {
  const { revenue, expenses, income } = await computeHuskPool();
  const totalExpenses = Object.values(expenses).reduce((s, v) => s + v, 0);
  const totalIncomeAdd = Object.values(income).reduce((s, v) => s + v, 0);
  const netRecovery = revenue + totalIncomeAdd - totalExpenses;
  res.json({ revenue, expenses, income, totalExpenses, totalIncomeAdd, netRecovery });
}
