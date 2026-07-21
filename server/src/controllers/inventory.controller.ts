import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { SaleProduct } from '@prisma/client';
import { withCache } from '../lib/cache.js';
import { companyHamaliShare, calcSaleFreight, PAPPU_OUT_TURN } from '../lib/calc.js';
import { getFreightRateForDestination } from './settings.controller.js';
import { InventoryService } from '../services/inventory.service.js';
import { computeUnifiedStockEngine } from '../services/stockEngine.js';

/**
 * Detailed black seed stock endpoint: the rows above plus pappu/husk/waste sold &
 * committed aggregates the Stock pages need.
 */
export async function getBlackSeedStock(_req: Request, res: Response) {
  // These five reads are independent, so fire them in parallel rather than paying
  // a serial DB round-trip for each (previously 7 sequential queries). The three
  // per-product "committed" figures also collapse into ONE sale-order query below.
  const [rows, dispatches, committedOrders, milledAgg, pos] = await Promise.all([
    InventoryService.computeBlackSeedRows(),
    // Product sold = all dispatched shipments (RVP kata weight). Pappu nets down the
    // raw pool; husk/waste net down their own derived availability.
    prisma.saleDispatch.findMany({
      select: { weightKg: true, saleOrder: { select: { product: true } } },
    }),
    // Committed amounts drive depletion. A sale draws down the moment the ORDER is
    // placed. One query covers every product we compute a committed figure for.
    prisma.saleOrder.findMany({
      where: { product: { in: ['PAPPU', 'HUSK', 'WASTE'] } },
      select: { product: true, tonnageKg: true, dispatches: { select: { weightKg: true } } },
    }),
    // Total black seed consumed in milling (pappu sold + black seed consumed on it).
    // This is the authoritative raw-stock depletion figure: once seed enters the mill
    // it is no longer raw, regardless of whether the output pappu has been sold yet.
    prisma.processing.aggregate({ _sum: { blackWeightKg: true } }),
    // Total tonnage committed across all live (non-cancelled) purchase orders,
    // used to project the pappu we are committed to producing (60% out-turn).
    prisma.purchaseOrder.findMany({
      where: { status: { not: 'CANCELLED' } },
      include: { stockIns: { select: { rvpKataKg: true } } },
    }),
  ]);

  const soldKg = (...products: SaleProduct[]) =>
    dispatches
      .filter((d) => products.includes(d.saleOrder.product))
      .reduce((s, d) => s + d.weightKg, 0);
  const pappuSoldKg = soldKg('PAPPU');
  const huskSoldKg = soldKg('HUSK');
  const wasteSoldKg = soldKg('WASTE');
  // Shell, Waste and the three pre-cleaner byproducts all draw down the single
  // shared 10% "Pre Cleaner Husk & Tamarind" pool.
  const wastePoolSoldKg = soldKg('WASTE', 'SHELL', 'PRECLEANER_DUST', 'NALLA_POKKULU', 'NALLA_CHINTAPANDU');

  const committedKg = (product: SaleProduct) =>
    committedOrders
      .filter((so) => so.product === product)
      .reduce((sum, so) => {
        const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
        return sum + Math.max(so.tonnageKg, dispatched);
      }, 0);
  const pappuCommittedKg = committedKg('PAPPU');
  const huskCommittedKg = committedKg('HUSK');
  const wasteCommittedKg = committedKg('WASTE');

  const totalMilledKg = milledAgg._sum.blackWeightKg ?? 0;

  const pendingPoTonnageKg = pos.reduce((sum, po) => {
    const arrived = po.stockIns.reduce((s, si) => s + si.rvpKataKg, 0);
    return sum + Math.max(0, po.tonnageKg - arrived);
  }, 0);

  res.json({ rows, pappuSoldKg, pappuCommittedKg, huskSoldKg, huskCommittedKg, wasteSoldKg, wasteCommittedKg, wastePoolSoldKg, totalMilledKg, pendingPoTonnageKg });
}

/**
 * Stock grouped by black-seed purchase price (₹/kg), for the Pappu Order Planner.
 *
 * Each price band is a PAPPU "minus-balance account":
 *   - CREDIT - black seed arriving in the band (verified lorries) and, separately,
 *              the un-arrived ordered tonnage of still-OPEN (PENDING) POs that is
 *              still coming.
 *   - DEBIT  - pappu committed to customers, driven by REAL sales: what has shipped
 *              (SaleDispatch) plus what is still open on un-shipped sale orders.
 *              SaleAllocation records are NOT used here - imported/historical sales
 *              have none, so relying on them under-depletes the bank.
 *
 * The debit is in CONSUMABLE pappu (what a customer actually receives). Only
 * PAPPU_CONSUMABLE (80%) of milled pappu is sellable; the other 20% is a buffer
 * reserve (waste / safety stock) that is never sold. So one kg of consumable pappu
 * needs 1 / (out-turn × consumable) kg of seed. The seed-equivalent debit is drawn
 * down across the bands MOST-EXPENSIVE-BAND FIRST (mirroring the allocation engine),
 * consuming each band's ARRIVED seed first, then its PENDING (still-coming) seed.
 *
 * Negative balances come from arrival SHORTFALLS: when a PO has already arrived
 * (status ARRIVED/COMPLETED) but its received weight fell short of the order, the
 * gap is a shortfall - the buffer absorbs it first, and anything beyond the buffer
 * eats into consumable pappu and is reported as a negative balance.
 *
 * A single out-turn (PAPPU_OUT_TURN) bridges seed↔pappu everywhere on this page;
 * PAPPU_CONSUMABLE then bridges milled pappu↔sellable pappu.
 */
export async function getStockByPrice(_req: Request, res: Response) {
  const { bands, totalAllocatedPappuKg, totalDeficitPappuKg, outTurnPct, consumablePct } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');
  res.json({ bands, totalAllocatedPappuKg, totalDeficitPappuKg, outTurnPct, consumablePct });
}

export async function getStockByParty(req: Request, res: Response) {
  const { allLots } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');

  // 'RVP' shows only seed physically at the mill; anything else (default/'ALL')
  // combines RVP with stock still sitting at outside storage locations.
  const locationFilter = typeof req.query.location === 'string' ? req.query.location.toUpperCase() : 'ALL';
  const scopedLots = locationFilter === 'RVP' ? allLots.filter((lot) => lot.location === 'RVP') : allLots;

  const partyMap = new Map<string, any>();
  for (const lot of scopedLots) {
    if (!partyMap.has(lot.partyId)) {
      partyMap.set(lot.partyId, {
        partyId: lot.partyId,
        partyName: lot.partyName,
        phone: lot.partyPhone || 'N/A',
        address: lot.partyAddress || 'N/A',
        state: lot.partyState,
        totalPurchasedKg: 0,
        totalMilledKg: 0,
        netStockKg: 0,
        totalValuation: 0,
        pricePools: [],
      });
    }
    const p = partyMap.get(lot.partyId)!;
    // Stock-by-Party shows the FULL stock received/purchased per party - it must
    // NOT be depleted by downstream pappu milling/sales. The stock engine reduces
    // `receivedKg` in place by whatever was consumed (`soldKg`), so the original
    // gross received amount is `receivedKg + soldKg`.
    const grossKg = lot.receivedKg + lot.soldKg;
    p.totalPurchasedKg += lot.orderedKg;
    p.totalMilledKg += lot.soldKg;
    p.netStockKg += grossKg;

    const value = grossKg * lot.pricePerKg;
    p.totalValuation += value;

    let pool = p.pricePools.find((pl: any) => pl.pricePerKg === lot.pricePerKg);
    if (!pool) {
      pool = {
        pricePerKg: lot.pricePerKg,
        totalPurchasedKg: 0,
        totalMilledKg: 0,
        netStockKg: 0,
        purchasedValue: 0,
        value: 0,
        stockIns: [],
      };
      p.pricePools.push(pool);
    }
    pool.totalPurchasedKg += lot.orderedKg;
    pool.totalMilledKg += lot.soldKg;
    pool.netStockKg += grossKg;
    pool.purchasedValue += lot.orderedKg * lot.pricePerKg;
    pool.value += value;
    pool.stockIns.push({
      id: lot.purchaseId,
      arrivalDate: lot.date,
      lorryNumber: lot.lorryNumber,
      invoiceNumber: lot.poNumber,
      purchasedWeightKg: lot.orderedKg,
      netWeightKg: lot.orderedKg,
      poNumber: lot.poNumber,
      value: lot.orderedKg * lot.pricePerKg,
    });
  }

  const stockByParty = Array.from(partyMap.values()).map(p => {
    p.pricePools.sort((a: any, b: any) => b.pricePerKg - a.pricePerKg);
    p.weightedAveragePrice = p.netStockKg > 0 ? p.totalValuation / p.netStockKg : 0;
    return p;
  });

  res.json(stockByParty);
}

export async function getStockByState(req: Request, res: Response) {
  const { allLots } = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');
  
  const stateMap = new Map<string, any>();
  const partyCountByState = new Map<string, Set<string>>();

  for (const lot of allLots) {
    const state = lot.partyState;
    if (!stateMap.has(state)) {
      stateMap.set(state, {
        state,
        totalPurchasedKg: 0,
        totalMilledKg: 0,
        netStockKg: 0,
        totalValue: 0,
        supplierCount: 0,
      });
      partyCountByState.set(state, new Set<string>());
    }
    partyCountByState.get(state)!.add(lot.partyId);

    const s = stateMap.get(state)!;
    s.totalPurchasedKg += lot.orderedKg;
    s.totalMilledKg += lot.soldKg;
    s.netStockKg += lot.receivedKg;
    s.totalValue += (lot.receivedKg * lot.pricePerKg);
  }

  for (const [state, s] of stateMap.entries()) {
    s.supplierCount = partyCountByState.get(state)!.size;
  }

  const result = Array.from(stateMap.values()).sort((a, b) => b.netStockKg - a.netStockKg);
  res.json(result);
}

/**
 * Get all inventory silos.
 */
export async function getSilos(req: Request, res: Response) {
  const silos = await prisma.siloInventory.findMany();
  res.json(silos);
}

export async function getCalculatorDefaults(req: Request, res: Response) {
  // Latest black seed price
  const latestPo = await prisma.purchaseOrder.findFirst({
    orderBy: { poDate: 'desc' },
  });
  const blackSeedPrice = latestPo ? Number(latestPo.pricePerKg) : 0;

  // Latest husk sale price
  const latestHuskSale = await prisma.saleOrder.findFirst({
    where: { product: 'HUSK' },
    orderBy: { saleDate: 'desc' },
  });
  const huskPrice = latestHuskSale ? Number(latestHuskSale.ratePerKg) : 0;

  // Latest waste sale price
  const latestWasteSale = await prisma.saleOrder.findFirst({
    where: { product: 'WASTE' },
    orderBy: { saleDate: 'desc' },
  });
  const wastePrice = latestWasteSale ? Number(latestWasteSale.ratePerKg) : 0;

  res.json({
    blackSeedPrice,
    millingCost: 1, // Default processing cost
    huskPrice,
    wastePrice,
  });
}

/**
 * Per-order profit/loss margin for every PAPPU sale order, incl. backdated ones.
 *
 * Uses the SAME date-aware chronological allocation as the Order Planner: each
 * order draws the seed available at its sale date, dearest-first, so every order
 * is costed on the ACTUAL black seed that backed it (not a blended pool average).
 * The sale price is a DELIVERED price (freight-inclusive), so freight is netted
 * out of realisation. Margin = revenue − freight − brokerage − seed cost −
 * production cost. GST is a pass-through and excluded.
 */
async function _computePappuOrderMargins() {
  const EPS = 1e-6;

  // Arrived-at-process seed timeline (real RVP lorries + transferred-in, repriced).
  const rows = await InventoryService.computeBlackSeedRows();
  type Ref = { price: number; date: Date; remainingKg: number };
  const refs: Ref[] = rows
    .filter((r) => r.location === 'RVP' && r.rvpNetWeightKg > 0)
    .map((r) => ({ price: r.pricePerKg, date: r.date, remainingKg: r.rvpNetWeightKg }));

  const orders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { buyer: true, dispatches: { select: { weightKg: true } } },
    orderBy: { saleDate: 'asc' },
  });

  const prodRows = await prisma.productionCostComponent.findMany();
  const prodCostPerKg = prodRows.reduce((s, r) => s + Number(r.ratePerKg), 0);

  // Outward freight is netted out of the (freight-inclusive) sale price. Use the
  // CURRENT Settings rate for each order's destination - so backdated orders whose
  // stored freightCharge predates the rate setup are still costed correctly.
  const destOf = (so: { destination: string | null; buyer: { destination: string | null } }) =>
    so.destination ?? so.buyer?.destination ?? null;
  const freightRateByDest = new Map<string, number>();
  for (const so of orders) {
    const key = destOf(so) ?? '';
    if (!freightRateByDest.has(key)) freightRateByDest.set(key, await getFreightRateForDestination(destOf(so)));
  }

  // Per order → the price bands (and seed kg) that backed it.
  const orderSeed = new Map<string, Map<string, { price: number; seedKg: number }>>();
  const recordDraw = (orderId: string, price: number, seedKg: number) => {
    let m = orderSeed.get(orderId);
    if (!m) { m = new Map(); orderSeed.set(orderId, m); }
    const key = price.toFixed(2);
    const e = m.get(key) ?? { price, seedKg: 0 };
    e.seedKg += seedKg;
    m.set(key, e);
  };

  type AllocEvent =
    | { t: number; kind: 'arrive'; ref: Ref }
    | { t: number; kind: 'sale'; orderId: string; seedNeed: number };
  const events: AllocEvent[] = [];
  for (const r of refs) events.push({ t: r.date.getTime(), kind: 'arrive', ref: r });
  const committedOf = new Map<string, number>();
  for (const so of orders) {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    const committed = Math.max(so.tonnageKg, dispatched);
    committedOf.set(so.id, committed);
    if (committed > 0) events.push({ t: so.saleDate.getTime(), kind: 'sale', orderId: so.id, seedNeed: committed / PAPPU_OUT_TURN });
  }
  events.sort((a, z) => a.t - z.t || (a.kind === 'arrive' ? -1 : 1));

  const pool: Ref[] = [];
  const draw = (orderId: string, needSeed: number): number => {
    if (needSeed <= EPS) return 0;
    pool.sort((a, z) => (z.price - a.price) || (a.date.getTime() - z.date.getTime()));
    for (const r of pool) {
      if (needSeed <= EPS) break;
      if (r.remainingKg <= EPS) continue;
      const take = Math.min(needSeed, r.remainingKg);
      r.remainingKg -= take;
      recordDraw(orderId, r.price, take);
      needSeed -= take;
    }
    return needSeed;
  };
  const backlog: { orderId: string; seedNeed: number }[] = [];
  for (const ev of events) {
    if (ev.kind === 'arrive') {
      pool.push(ev.ref);
      while (backlog.length > 0) {
        const left = draw(backlog[0].orderId, backlog[0].seedNeed);
        if (left > EPS) { backlog[0].seedNeed = left; break; }
        backlog.shift();
      }
    } else {
      const left = draw(ev.orderId, ev.seedNeed);
      if (left > EPS) backlog.push({ orderId: ev.orderId, seedNeed: left });
    }
  }

  const result = orders.map((so) => {
    const qty = so.tonnageKg; // ordered pappu kg (freight/GST are computed on this)
    const rate = Number(so.ratePerKg);
    const freight = calcSaleFreight(qty, freightRateByDest.get(destOf(so) ?? '') ?? 0);
    const brokerage = Math.round(qty * Number(so.brokerageRatePerKg) * 100) / 100;

    const bandsMap = orderSeed.get(so.id) ?? new Map<string, { price: number; seedKg: number }>();
    const seedBands = [...bandsMap.values()]
      .sort((a, b) => b.price - a.price)
      .map((b) => ({ price: b.price, seedKg: Math.round(b.seedKg), cost: Math.round(b.price * b.seedKg * 100) / 100 }));
    const seedKg = seedBands.reduce((s, b) => s + b.seedKg, 0);
    const seedCost = Math.round(seedBands.reduce((s, b) => s + b.cost, 0) * 100) / 100;

    const prodCost = Math.round(qty * prodCostPerKg * 100) / 100;
    const revenue = Math.round(qty * rate * 100) / 100;
    const netRealization = Math.round((revenue - freight - brokerage) * 100) / 100;
    const margin = Math.round((netRealization - seedCost - prodCost) * 100) / 100;

    return {
      orderId: so.id,
      buyer: so.buyer?.name ?? '-',
      destination: destOf(so),
      saleDate: so.saleDate,
      committedPappuKg: committedOf.get(so.id) ?? qty,
      orderedKg: qty,
      ratePerKg: rate,
      revenue,
      freight,
      freightPerKg: qty > 0 ? Math.round((freight / qty) * 100) / 100 : 0,
      brokerage,
      seedKg,
      seedCost,
      seedWacPerKg: seedKg > 0 ? Math.round((seedCost / seedKg) * 100) / 100 : 0,
      seedCostPerPappuKg: qty > 0 ? Math.round((seedCost / qty) * 100) / 100 : 0,
      prodCostPerKg: Math.round(prodCostPerKg * 100) / 100,
      prodCost,
      netRealization,
      margin,
      marginPerKg: qty > 0 ? Math.round((margin / qty) * 100) / 100 : 0,
      marginPct: revenue > 0 ? Math.round((margin / revenue) * 10000) / 100 : 0,
      seedBands,
    };
  });

  return result;
}

export async function computePappuOrderMargins() {
  // TTL is a safety net only — a successful mutation clears this cache (see the
  // invalidation middleware in routes/index.ts), so the longer window only speeds
  // up read-only navigation and never serves post-write stale margins.
  return withCache('pappu_order_margins', 120, _computePappuOrderMargins);
}

export async function getPappuOrderMargins(_req: Request, res: Response) {
  res.json(await computePappuOrderMargins());
}

