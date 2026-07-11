import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { getHamaliRateFull, getCustomHamaliRates } from './settings.controller.js';
import { customLoadingHamali } from '../lib/calc.js';

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
  pappuLoading: number;
  pappuRoasting: number;
  huskLoading: number;
  tWasteLoading: number;
  bagCutting: number;
  pappuNet: number;
  diesel: number;
  misc: number;
  gunnyBags: number;
  electricity: number;
  maintenance: number;
  drawingsShabri: number;
  drawingsReddy: number;
  ccInterest: number;
  termLoanInterest: number;
}

// Map frontend expense labels to their exact backend keys. Also flag the 
// pappu-flagged ones so Net Profit does not double-count them.
export const HUSK_EXPENSE_META: { key: keyof HuskExpenses; label: string; pappu: boolean }[] = [
  { key: 'blackSeedUnloading', label: 'Black Seed Unloading', pappu: false },
  { key: 'transferCosts',      label: 'Stock Transfer Costs', pappu: false },
  { key: 'pappuLoading',       label: 'Pappu Loading',        pappu: true  },
  { key: 'pappuRoasting',      label: 'Pappu Roasting',       pappu: true  },
  { key: 'huskLoading',        label: 'Husk Loading',         pappu: false },
  { key: 'tWasteLoading',      label: 'T-Waste Loading',      pappu: false },
  { key: 'bagCutting',         label: 'Bag Cutting',          pappu: false },
  { key: 'pappuNet',           label: 'Pappu Net (Rasi)',     pappu: true  },
  { key: 'diesel',             label: 'Diesel',               pappu: false },
  { key: 'misc',               label: 'Miscellaneous',        pappu: false },
  { key: 'gunnyBags',          label: 'Gunny Bags (net)',     pappu: false },
  { key: 'electricity',        label: 'Electricity',          pappu: false },
  { key: 'maintenance',        label: 'Maintenance',          pappu: false },
  { key: 'drawingsShabri',     label: 'Drawings - Shabri',    pappu: false },
  { key: 'drawingsReddy',      label: 'Drawings - Reddy',     pappu: false },
  { key: 'ccInterest',         label: 'CC Interest',          pappu: false },
  { key: 'termLoanInterest',   label: 'Term Loan Interest',   pappu: false },
];

// Shared husk-pool computation: pooled byproduct revenue + every operating cost,
// itemized. Loading-hamali lines are recomputed from current ₹/tonne rates ×
// dispatched tonnage; the four standalone reports (gunny/electricity/maintenance/
// drawings) are read from their own tables. Used by the dashboard recovery card
// and by the P&L page's husk pool.
export async function computeHuskPool(): Promise<{ revenue: number; expenses: HuskExpenses }> {
  const [
    revAccount,
    dispatches,
    blackSeedHamali,
    manualByType,
    gunnyByDir,
    electricityAgg,
    maintenanceAgg,
    drawingsByOwner,
    interestByType,
    pappuRate,
    huskRate,
    wasteRate,
    customRates,
    transferAgg,
    shellAgg,
    huskAgg,
  ] = await Promise.all([
      prisma.account.findUnique({ where: { code: '40010' }, select: { id: true } }),
      prisma.saleDispatch.findMany({ select: { weightKg: true, saleOrder: { select: { product: true } } } }),
      prisma.purchase.aggregate({ _sum: { hamaliCharge: true } }),
      (prisma.manualHamaliCost.groupBy as any)({ by: ['type'], _sum: { amount: true } }),
      (prisma.gunnyBagEntry.groupBy as any)({ by: ['direction'], _sum: { amount: true } }),
      prisma.electricityBill.aggregate({ _sum: { amount: true } }),
      prisma.maintenanceExpense.aggregate({ _sum: { amount: true } }),
      (prisma.drawing.groupBy as any)({ by: ['owner'], _sum: { amount: true } }),
      (prisma.interestCharge.groupBy as any)({ by: ['type'], _sum: { amount: true } }),
      getHamaliRateFull('PAPPU_LOADING'),
      getHamaliRateFull('HUSK_LOADING'),
      getHamaliRateFull('WASTE_LOADING'),
      getCustomHamaliRates(),
      prisma.stockTransfer.aggregate({ _sum: { transportCharge: true, unloadingHamali: true } }),
      prisma.shellTransfer.aggregate({ _sum: { transportCharge: true, hamaliCharge: true } }),
      prisma.huskTransfer.aggregate({ _sum: { transportCharge: true, hamaliCharge: true } }),
    ]);

    // ── Revenue: pooled byproduct sales revenue (net credits on 40010) ──────────
    let revenue = 0;
    if (revAccount) {
      const revLines = await prisma.journalLine.aggregate({
        _sum: { credit: true, debit: true },
        where: { accountId: revAccount.id, costCenter: { in: POOL_REVENUE_COST_CENTERS } },
      });
      revenue = Number(revLines._sum.credit ?? 0) - Number(revLines._sum.debit ?? 0);
    }

    // ── Dispatched tonnage per product (drives recomputed loading hamali) ───────
    let pappuKg = 0, huskKg = 0, wasteKg = 0;
    for (const d of dispatches) {
      const product = d.saleOrder.product;
      if (product === 'PAPPU') pappuKg += d.weightKg;
      else if (product === 'HUSK') huskKg += d.weightKg;
      else if (WASTE_LOADING_PRODUCTS.has(product)) wasteKg += d.weightKg;
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
    const diesel = manual['DIESEL'] ?? 0;
    const misc = manual['MISC'] ?? 0;

    // ── Static/Standalone Expenses ──────────
    const transferCosts = 
      (Number(transferAgg._sum.transportCharge || 0) + Number(transferAgg._sum.unloadingHamali || 0)) +
      (Number(shellAgg._sum.transportCharge || 0) + Number(shellAgg._sum.hamaliCharge || 0)) +
      (Number(huskAgg._sum.transportCharge || 0) + Number(huskAgg._sum.hamaliCharge || 0));

    const gunny = Object.fromEntries(
      (gunnyByDir as any[]).map((r) => [r.direction, Number(r._sum.amount ?? 0)]),
    );
    const gunnyBags = (gunny['PURCHASE'] ?? 0) - (gunny['SALE'] ?? 0);
    const electricity = Number(electricityAgg._sum.amount ?? 0);
    const maintenance = Number(maintenanceAgg._sum.amount ?? 0);
    const drawings = Object.fromEntries(
      (drawingsByOwner as any[]).map((r) => [r.owner, Number(r._sum.amount ?? 0)]),
    );
    const interest = Object.fromEntries(
      (interestByType as any[]).map((r) => [r.type, Number(r._sum.amount ?? 0)]),
    );

    const expenses = {
      blackSeedUnloading: Number(blackSeedHamali._sum.hamaliCharge ?? 0),
      transferCosts,
      pappuLoading,
      pappuRoasting,
      huskLoading,
      tWasteLoading,
      bagCutting,
      pappuNet,
      diesel,
      misc,
      gunnyBags,
      electricity,
      maintenance,
      drawingsShabri: drawings['SHABRI'] ?? 0,
      drawingsReddy: drawings['REDDY'] ?? 0,
      ccInterest: interest['CC'] ?? 0,
      termLoanInterest: interest['TERM_LOAN'] ?? 0,
    };

  return { revenue, expenses };
}

// Dashboard husk-recovery card: full itemized pool (includes pappu-flagged costs).
export async function huskPnl(_req: Request, res: Response) {
  const { revenue, expenses } = await computeHuskPool();
  const totalExpenses = Object.values(expenses).reduce((s, v) => s + v, 0);
  const netRecovery = revenue - totalExpenses;
  res.json({ revenue, expenses, totalExpenses, netRecovery });
}
