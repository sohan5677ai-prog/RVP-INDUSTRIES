import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { SaleProduct } from '@prisma/client';
import { withCache, clearCache } from '../lib/cache.js';
import { companyHamaliShare, calcSaleFreight, PAPPU_OUT_TURN, PAPPU_CONSUMABLE, seedBackedDemandKg, excessOutKgOf } from '../lib/calc.js';
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
      select: { product: true, tonnageKg: true, closedAt: true, dispatches: { select: { weightKg: true } } },
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
        // A closed order commits only what actually went out. Husk is the worst
        // case: no lorry ever lands on the booked figure, so without this every
        // finished order leaves a slice of the pool committed to a balance that
        // is never going to ship.
        return sum + (so.closedAt != null ? dispatched : Math.max(so.tonnageKg, dispatched));
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
  // Only ARRIVED lots. The engine also emits PENDING lots for un-arrived POs
  // (DELIVERY-priced, RVP-planned ones - see stockEngine.ts), tagged location
  // 'RVP' so the location filter alone wouldn't drop them. Counting them here
  // inflated net stock/valuation/WAC with seed that hasn't landed, and
  // double-counted a partly-arrived PO's tonnage because a PENDING lot carries
  // the FULL ordered tonnage in `orderedKg`, not just the outstanding gap.
  const scopedLots = (locationFilter === 'RVP' ? allLots.filter((lot) => lot.location === 'RVP') : allLots)
    .filter((lot) => lot.kind === 'ARRIVED');

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

  // Same as Stock by Party: skip PENDING (un-arrived PO) lots so a state's
  // tonnage/valuation reflects only seed that has actually been received.
  for (const lot of allLots) {
    if (lot.kind !== 'ARRIVED') continue;
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
    millingCost: 2.5, // Default processing cost
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
 * out of realisation. Margin = revenue − freight − seed cost.
 * GST is a pass-through and excluded. Milling/labour is NOT costed here - it is
 * already carried by the hamali rates. Brokerage is NOT netted here either - it
 * is booked once, dispatch-gated, as a Husk Pool overhead (see computeHuskPool).
 */
/** Shape stored in SaleOrder.seedCostSnapshot once an order is fully dispatched. */
type FrozenSeed = {
  seedBands: { price: number; seedKg: number; cost: number }[];
  seedKg: number;
  seedCost: number;
};

async function _computePappuOrderMargins() {
  // Use the authoritative unified stock engine for seed allocation:
  const stockResult = await computeUnifiedStockEngine('MOST_EXPENSIVE_FIRST');

  // Per order → the price bands (and seed kg) that backed it across arrived and pending lots.
  const orderSeedMap = new Map<string, Map<string, { price: number; seedKg: number }>>();
  for (const b of stockResult.bands) {
    for (const lot of b.lots) {
      for (const c of (lot.consumedBy || [])) {
        let m = orderSeedMap.get(c.orderId);
        if (!m) { m = new Map(); orderSeedMap.set(c.orderId, m); }
        const key = lot.pricePerKg.toFixed(2);
        const e = m.get(key) ?? { price: lot.pricePerKg, seedKg: 0 };
        e.seedKg += c.seedKg;
        m.set(key, e);
      }
    }
  }

  const orders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { buyer: true, dispatches: { select: { weightKg: true, excessOutKg: true, freightCharge: true } } },
    // id is the tie-break, not decoration: two orders on the SAME sale date would
    // otherwise come back in arbitrary Postgres order, and whichever the
    // allocator reached first took the scarce seed. That silently moved money
    // between same-day orders on every page load.
    orderBy: [{ saleDate: 'asc' }, { id: 'asc' }],
  });

  // Outward freight is netted out of the (freight-inclusive) sale price.
  //
  // What we charge an order is its ACTUAL freight wherever a lorry has shipped:
  // each SaleDispatch carries the real rupee figure the transporter quoted, taken
  // from their WhatsApp confirmation (see confirmTransportConfirmation). Only the
  // still-undispatched balance is estimated, at the order's stamped rate below.
  // A booked lorry at 80,000 on a route the Settings rate calls 84,000 is a 4,000
  // margin difference this used to miss entirely.
  //
  // Rates are read off the ORDER (stamped when it was taken), not from Settings.
  // That is what stops a rate change rewriting history: putting Surat up from
  // 2800 to 3000 now applies only to orders taken after the change, because
  // earlier orders carry their own 2800. The live rate is only a fallback for
  // legacy rows the backfill has not stamped yet.
  const destOf = (so: { destination: string | null; buyer: { destination: string | null } }) =>
    so.destination ?? so.buyer?.destination ?? null;
  const liveFreightRateByDest = new Map<string, number>();
  for (const so of orders) {
    if (so.freightRatePerTonne != null) continue; // stamped - no live lookup needed
    const key = destOf(so) ?? '';
    if (!liveFreightRateByDest.has(key)) liveFreightRateByDest.set(key, await getFreightRateForDestination(destOf(so)));
  }
  const freightRateOf = (so: (typeof orders)[number]) =>
    so.freightRatePerTonne != null
      ? Number(so.freightRatePerTonne)
      : (liveFreightRateByDest.get(destOf(so) ?? '') ?? 0);

  const committedOf = new Map<string, number>();
  for (const so of orders) {
    const committed = seedBackedDemandKg(so.tonnageKg, so.dispatches, so.closedAt != null);
    committedOf.set(so.id, committed);
  }

  const result = orders.map((so) => {
    const dispatchedKg = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    // Ordered pappu kg (GST is computed on this). A CLOSED order is taking no
    // more lorries, so what shipped is the order: billing it on a booked tonnage
    // that was never fully lifted would overstate both revenue and freight.
    const qty = so.closedAt != null ? dispatchedKg : so.tonnageKg;
    const rate = Number(so.ratePerKg);

    // Actual freight on the lorries that have shipped + an estimate, at the
    // order's stamped rate, on the tonnage still to go. A fully shipped order is
    // therefore 100% actuals, and a part-shipped one blends the two rather than
    // reverting the whole order to the Settings rate.
    const actualFreight = so.dispatches.reduce((s, d) => s + Number(d.freightCharge), 0);
    const pendingKg = Math.max(0, qty - dispatchedKg);
    const freight =
      Math.round((actualFreight + calcSaleFreight(pendingKg, freightRateOf(so))) * 100) / 100;

    const bandsMap = orderSeedMap.get(so.id) ?? new Map<string, { price: number; seedKg: number }>();
    const liveBands = [...bandsMap.values()]
      .sort((a, b) => b.price - a.price)
      .map((b) => ({ price: b.price, seedKg: Math.round(b.seedKg), cost: Math.round(b.price * b.seedKg * 100) / 100 }));

    // Dynamic date-aware allocation: live draw always drives seedBands and seedCost so that
    // correcting purchase typos (e.g. Base rate vs Delivery rate) accurately recalculates profit.
    const seedBands = liveBands;
    const seedKg = liveBands.reduce((s, b) => s + b.seedKg, 0);
    const seedCost = Math.round(liveBands.reduce((s, b) => s + b.cost, 0) * 100) / 100;

    const revenue = Math.round(qty * rate * 100) / 100;
    // Brokerage is deliberately NOT netted here - it is booked once, dispatch-
    // gated, as a Husk Pool overhead (flat ₹2000/dispatch, mirroring the
    // Brokerage Ledger/Dues reports). Netting it again per-order here would
    // double-count it against the same shipment.
    const netRealization = Math.round((revenue - freight) * 100) / 100;
    const margin = Math.round((netRealization - seedCost) * 100) / 100;

    return {
      orderId: so.id,
      buyer: so.buyer?.name ?? '-',
      destination: destOf(so),
      saleDate: so.saleDate,
      committedPappuKg: committedOf.get(so.id) ?? qty,
      // XS tonnage carries zero seed cost by design (the seed was already fully
      // recovered over the assumed 60% out-turn), so these rows show a ~100%
      // margin. Correct as a rupee total, but NOT a per-kg rate benchmark -
      // hence the badge on the Pappu P&L row.
      excessOutKg: Math.round(excessOutKgOf(so.dispatches)),
      // Committed pappu with no seed behind it - i.e. sitting in the allocation
      // backlog, waiting to eat the next black seed to arrive at RVP. This is
      // what the dispatch gate offers the XS tick against.
      unbackedPappuKg: Math.round(
        Math.max(0, (committedOf.get(so.id) ?? qty) - seedKg * PAPPU_OUT_TURN),
      ),
      orderedKg: qty,
      ratePerKg: rate,
      revenue,
      freight,
      freightPerKg: qty > 0 ? Math.round((freight / qty) * 100) / 100 : 0,
      seedKg,
      seedCost,
      seedWacPerKg: seedKg > 0 ? Math.round((seedCost / seedKg) * 100) / 100 : 0,
      seedCostPerPappuKg: qty > 0 ? Math.round((seedCost / qty) * 100) / 100 : 0,
      // Frozen = this order is fully shipped and its costs are a historical
      // record; nothing bought, verified or re-rated later can move it.
      costFrozenAt: so.costFrozenAt,
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
  // TTL is a safety net only - a successful mutation clears this cache (see the
  // invalidation middleware in routes/index.ts), so the longer window only speeds
  // up read-only navigation and never serves post-write stale margins.
  return withCache('pappu_order_margins', 120, _computePappuOrderMargins);
}

export async function getPappuOrderMargins(_req: Request, res: Response) {
  res.json(await computePappuOrderMargins());
}

/**
 * Re-synchronize seed costs and margin snapshots across all sale orders.
 * Clears caches and writes updated dynamic allocations to the database.
 */
export async function resyncPappuCosts(_req: Request, res: Response) {
  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');
  const margins = await _computePappuOrderMargins();
  
  const updates = margins
    .filter((m) => m.costFrozenAt != null || m.seedKg > 0)
    .map((m) =>
      prisma.saleOrder.updateMany({
        where: { id: m.orderId },
        data: {
          seedCostSnapshot: {
            seedKg: m.seedKg,
            seedCost: m.seedCost,
            seedBands: m.seedBands,
          },
        },
      })
    );

  await Promise.all(updates);
  clearCache('pappu_order_margins');
  clearCache('unified_stock_engine');
  res.json({ message: `Re-synchronized seed costs across ${margins.length} orders successfully!`, count: margins.length });
}


