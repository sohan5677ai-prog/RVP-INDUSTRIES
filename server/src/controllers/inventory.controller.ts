import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { companyHamaliShare } from '../lib/calc.js';

/**
 * Detailed black seed stock: one row per recorded purchase (lorry). Milling does
 * NOT remove seed from this list — raw black seed is only depleted when the
 * finished pappu is sold (the frontend nets out the seed-equivalent of pappu
 * sold). Value = seed cost + the company's half of the hamali.
 */
export async function getBlackSeedStock(_req: Request, res: Response) {
  const purchases = await prisma.purchase.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      verification: true,
      stockIn: { include: { purchaseOrder: { include: { party: true } } } },
    },
  });

  const rows = purchases.map((p) => {
    const price = p.verification ? Number(p.verification.pricePerKg) : Number(p.stockIn.purchaseOrder.pricePerKg);
    const ourHamali = companyHamaliShare(Number(p.hamaliCharge));
    const freight = Number(p.freightCharge);
    // RVP net (kata) weight of black seed received.
    const rvpNetWeightKg = p.netWeightKg;

    const igst = p.verification
      ? Math.round(Number(p.verification.billingWeightKg) * Number(p.verification.pricePerKg) * 0.05 * 100) / 100
      : 0;

    // Use physical weight for seed cost calculation to avoid shortage inflating the unit price.
    const seedCostWithoutGst = rvpNetWeightKg * price;
    const proportionalGst = p.verification && Number(p.verification.billingWeightKg) > 0
      ? igst * (rvpNetWeightKg / Number(p.verification.billingWeightKg))
      : 0;
    const seedCost = seedCostWithoutGst + proportionalGst;

    const value = Math.round((seedCost + ourHamali + freight) * 100) / 100;

    const priceType = p.stockIn.purchaseOrder.priceType || 'BASE';
    const isBasePrice = priceType === 'BASE';
    const addedFreight = isBasePrice ? freight : 0;

    const valueExclGstAndHamali = Math.round((seedCostWithoutGst + addedFreight) * 100) / 100;
    const valueExclHamali = Math.round((seedCost + addedFreight) * 100) / 100;

    return {
      purchaseId: p.id,
      date: p.stockIn.arrivalDate,
      invoiceNumber: p.stockIn.invoiceNumber,
      partyName: p.stockIn.purchaseOrder.party.name,
      poNumber: p.stockIn.purchaseOrder.poNumber,
      lorryNumber: p.stockIn.lorryNumber,
      rvpNetWeightKg,
      location: p.stockIn.loadingLocation,
      pricePerKg: price,
      hamaliCharge: Number(p.hamaliCharge),
      companyHamali: ourHamali,
      bunkerPlace: p.bunkerPlace,
      value,
      valueExclGstAndHamali,
      valueExclHamali,
      verified: !!p.verification,
    };
  });

  // Product sold = all dispatched shipments (RVP kata weight). Pappu nets down the
  // raw pool; husk/waste net down their own derived availability.
  const dispatches = await prisma.saleDispatch.findMany({
    select: { weightKg: true, saleOrder: { select: { product: true } } },
  });
  const soldKg = (product: string) =>
    dispatches.filter((d) => d.saleOrder.product === product).reduce((s, d) => s + d.weightKg, 0);
  const pappuSoldKg = soldKg('PAPPU');
  const huskSoldKg = soldKg('HUSK');
  const wasteSoldKg = soldKg('WASTE');

  // Committed pappu drives raw-seed depletion (same basis as Stock by Price): a pappu
  // sale draws seed down the moment the ORDER is placed, not just when it dispatches.
  // Per order, the footprint is max(ordered tonnage, already dispatched).
  const pappuOrders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { dispatches: { select: { weightKg: true } } },
  });
  const pappuCommittedKg = pappuOrders.reduce((sum, so) => {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(so.tonnageKg, dispatched);
  }, 0);

  // Total black seed consumed in milling (pappu sold + black seed consumed on it).
  // This is the authoritative raw-stock depletion figure: once seed enters the mill
  // it is no longer raw, regardless of whether the output pappu has been sold yet.
  const milledAgg = await prisma.processing.aggregate({ _sum: { blackWeightKg: true } });
  const totalMilledKg = milledAgg._sum.blackWeightKg ?? 0;

  // Total tonnage committed across all live (non-cancelled) purchase orders,
  // used to project the pappu we are committed to producing (60% out-turn).
  const poTonnageAgg = await prisma.purchaseOrder.aggregate({
    _sum: { tonnageKg: true },
    where: { status: { not: 'CANCELLED' } },
  });
  const poTonnageKg = poTonnageAgg._sum.tonnageKg ?? 0;

  res.json({ rows, pappuSoldKg, pappuCommittedKg, huskSoldKg, wasteSoldKg, totalMilledKg, poTonnageKg });
}

/**
 * Stock grouped by black-seed purchase price (₹/kg), for the Pappu Order Planner.
 *
 * Each price band is a PAPPU "minus-balance account":
 *   - CREDIT — black seed arriving in the band (verified lorries) and, separately,
 *              the un-arrived ordered tonnage of still-OPEN (PENDING) POs that is
 *              still coming.
 *   - DEBIT  — pappu committed to customers, driven by REAL sales: what has shipped
 *              (SaleDispatch) plus what is still open on un-shipped sale orders.
 *              SaleAllocation records are NOT used here — imported/historical sales
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
 * gap is a shortfall — the buffer absorbs it first, and anything beyond the buffer
 * eats into consumable pappu and is reported as a negative balance.
 *
 * A single out-turn (PAPPU_OUT_TURN) bridges seed↔pappu everywhere on this page;
 * PAPPU_CONSUMABLE then bridges milled pappu↔sellable pappu.
 */
const PRICE_STORAGE_LOCATIONS = ['Rampalli', 'Murgan', 'Multi'];
const PAPPU_OUT_TURN = 0.6;
// Fraction of milled pappu that is consumable/sellable; the remaining 20% is a
// buffer reserve (waste + safety stock) that is produced but never sold.
const PAPPU_CONSUMABLE = 0.8;

export async function getStockByPrice(_req: Request, res: Response) {
  const EPS = 1e-6;

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' } },
    include: {
      party: true,
      stockIns: {
        include: { purchase: { include: { verification: true } } },
      },
    },
    orderBy: { poDate: 'asc' },
  });

  // A lot is one row in a band's expansion panel. `kind` tells the three apart:
  //   ARRIVED  — seed physically received (CREDIT)
  //   PENDING  — un-arrived tonnage of a still-OPEN (PENDING) PO (future CREDIT,
  //              depletable by sales after arrived seed runs out)
  //   SHORTFALL — gap on a PO that has already arrived (ARRIVED/COMPLETED) but
  //              received less than ordered. Not a credit; drives negative balance.
  type LotKind = 'ARRIVED' | 'PENDING' | 'SHORTFALL';
  interface Lot {
    purchaseId: string;
    date: Date;
    partyName: string;
    lorryNumber: string;
    poNumber: string | null;
    kind: LotKind;
    orderedKg: number;   // PO order size (for SHORTFALL context); = receivedKg otherwise
    receivedKg: number;  // seed in this lot; reduced by sales draw-down for display
    soldKg: number;      // seed consumed from this lot by sales
  }
  interface Band {
    blackPricePerKg: number;
    lorries: number;
    // ARRIVED pool — physically at process (CREDIT)
    arrivedBlackKg: number;   // gross arrived
    arrivedValue: number;     // value of gross arrived
    // PENDING pool — ordered on still-open POs, not yet arrived (future CREDIT)
    pendingBlackKg: number;
    pendingValue: number;
    // SHORTFALL — seed an already-arrived PO failed to deliver (CREDIT that never came)
    shortfallBlackKg: number;
    // Consumable-pappu deficit from those shortfalls, AFTER the buffer absorbs its
    // share (the negative balance). >= 0 magnitude; reported negative on the client.
    shortfallPappuKg: number;
    lots: Lot[];
  }

  const bandMap = new Map<string, Band>();
  const getBand = (price: number): Band => {
    const key = price.toFixed(2);
    let b = bandMap.get(key);
    if (!b) {
      b = { blackPricePerKg: price, lorries: 0, arrivedBlackKg: 0, arrivedValue: 0, pendingBlackKg: 0, pendingValue: 0, shortfallBlackKg: 0, shortfallPappuKg: 0, lots: [] };
      bandMap.set(key, b);
    }
    return b;
  };

  // 1. Build bands: arrived lorries (CREDIT) + un-arrived ordered tonnage, split into
  //    PENDING (open PO, still coming) vs SHORTFALL (arrived PO that came up short).
  for (const po of purchaseOrders) {
    let totalPoNetKg = 0;
    const orderedKg = po.tonnageKg; // original order, never overwritten

    for (const si of po.stockIns) {
      if (!si.purchase) continue;
      const netKg = si.purchase.netWeightKg;
      if (netKg <= 0) continue;
      totalPoNetKg += netKg;

      const price = si.purchase.verification
        ? Number(si.purchase.verification.pricePerKg)
        : Number(po.pricePerKg);
      const ourHamali = companyHamaliShare(Number(si.purchase.hamaliCharge));
      // Stock-by-Price values arrived seed at the ACTUAL amount paid the supplier
      // (verification.totalAmount = reconciled weight × price + GST). This is
      // intentionally distinct from Black Seed Stock's physical-weight valuation.
      const seedCost = si.purchase.verification
        ? Number(si.purchase.verification.totalAmount)
        : netKg * price;
      const value = Math.round((seedCost + ourHamali + Number(si.purchase.freightCharge)) * 100) / 100;

      const b = getBand(price);
      b.lorries += 1;
      b.arrivedBlackKg += netKg;
      b.arrivedValue += value;
      b.lots.push({
        purchaseId: si.purchase.id,
        date: si.arrivalDate,
        partyName: po.party.name,
        lorryNumber: si.lorryNumber,
        poNumber: po.poNumber,
        kind: 'ARRIVED',
        orderedKg: netKg,
        receivedKg: netKg,
        soldKg: 0,
      });
    }

    const gapKg = Math.max(0, orderedKg - totalPoNetKg);
    if (gapKg > 0) {
      const price = Number(po.pricePerKg);
      const b = getBand(price);
      // A PENDING PO is still coming → future credit. An ARRIVED PO might still be
      // waiting for purchase entries (second weight) for its lorries.
      let isStillComing = false;
      if (po.status === 'PENDING') {
        isStillComing = true;
      } else if (po.status === 'ARRIVED') {
        const hasUnpurchased = po.stockIns.some(si => !si.purchase);
        if (hasUnpurchased) {
          isStillComing = true;
        }
      }

      if (isStillComing) {
        b.pendingBlackKg += gapKg;
        b.pendingValue += gapKg * price;
        b.lots.push({
          purchaseId: `pending-${po.id}`,
          date: po.poDate,
          partyName: po.party.name,
          lorryNumber: 'PENDING',
          poNumber: po.poNumber,
          kind: 'PENDING',
          orderedKg,
          receivedKg: gapKg,
          soldKg: 0,
        });
      } else {
        // Shortfall: the buffer reserve (20% of the ORDER's pappu) absorbs the gap
        // first; only the excess eats into consumable pappu → the negative balance.
        const bufferPappuKg = orderedKg * PAPPU_OUT_TURN * (1 - PAPPU_CONSUMABLE);
        const gapPappuKg = gapKg * PAPPU_OUT_TURN;
        const consumableDeficit = Math.max(0, gapPappuKg - bufferPappuKg);
        b.shortfallBlackKg += gapKg;
        b.shortfallPappuKg += consumableDeficit;
        b.lots.push({
          purchaseId: `shortfall-${po.id}`,
          date: po.poDate,
          partyName: po.party.name,
          lorryNumber: 'SHORT',
          poNumber: po.poNumber,
          kind: 'SHORTFALL',
          orderedKg,
          receivedKg: gapKg,
          soldKg: 0,
        });
      }
    }
  }

  const bands = [...bandMap.values()].sort((a, b) => b.blackPricePerKg - a.blackPricePerKg);

  // ── DEBIT: actual pappu committed to customers ───────────────────────────────
  // Driven by REAL sales, not SaleAllocation records: committed pappu = what has
  // shipped (SaleDispatch) PLUS what is still open on un-shipped orders. Sale tonnage
  // is CONSUMABLE pappu (what the customer receives).
  const pappuOrders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { dispatches: { select: { weightKg: true } } },
  });
  const committedPappuKg = pappuOrders.reduce((sum, so) => {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(so.tonnageKg, dispatched); // sold + still-open footprint
  }, 0);

  // Two-pass debit — arrived seed is ALWAYS exhausted before pending seed is touched.
  // Pass 1: draw from arrived bands most-expensive-first (yield = 0.6).
  // Pass 2: only if arrived is fully exhausted, draw from pending most-expensive-first
  //         (yield = 0.48, because the 20% buffer reserve cannot be sold).
  // This ensures Black Seed Remaining (arrived net of sales) matches every other page.
  const arrivedYield = PAPPU_OUT_TURN;
  const pendingYield = PAPPU_OUT_TURN * PAPPU_CONSUMABLE;

  const assignedArrivedSeed = new Map<string, number>(); // band key → arrived seed debited
  const assignedPendingSeed = new Map<string, number>(); // band key → pending seed debited

  let remainingDebit = committedPappuKg;

  // Pass 1: arrived seed only.
  for (const b of bands) {
    if (remainingDebit <= EPS) break;
    const arrivedConsumableAvail = b.arrivedBlackKg * arrivedYield;
    const take = Math.min(remainingDebit, arrivedConsumableAvail);
    if (take > 0) {
      assignedArrivedSeed.set(b.blackPricePerKg.toFixed(2), take / arrivedYield);
      remainingDebit -= take;
    }
  }

  // Pass 2: pending seed (only if arrived was insufficient).
  for (const b of bands) {
    if (remainingDebit <= EPS) break;
    const pendingConsumableAvail = b.pendingBlackKg * pendingYield;
    const take = Math.min(remainingDebit, pendingConsumableAvail);
    if (take > 0) {
      assignedPendingSeed.set(b.blackPricePerKg.toFixed(2), take / pendingYield);
      remainingDebit -= take;
    }
  }

  // Whatever could not be drawn from arrived + pending seed is the over-commitment
  // deficit (in consumable pappu).
  const totalDeficitPappuKg = remainingDebit;
  const totalAllocatedPappuKg = committedPappuKg;

  const result = bands.map((b) => {
    const key = b.blackPricePerKg.toFixed(2);
    const arrivedDebitKg = assignedArrivedSeed.get(key) ?? 0;
    const pendingDebitKg = assignedPendingSeed.get(key) ?? 0;
    const debitSeedKg = arrivedDebitKg + pendingDebitKg;

    const remainingBlackKg = b.arrivedBlackKg - arrivedDebitKg;   // arrived seed left (≥ 0)
    const remainingPendingKg = b.pendingBlackKg - pendingDebitKg; // pending seed left (≥ 0)

    // Value tracks only the seed still on the books for this band.
    const remFrac = b.arrivedBlackKg > 0 ? remainingBlackKg / b.arrivedBlackKg : 0;
    const pendFrac = b.pendingBlackKg > 0 ? remainingPendingKg / b.pendingBlackKg : 0;

    // Reflect the sales draw-down on each lot (date FIFO): arrived lots first, then
    // pending. Shortfall lots are never consumed.
    b.lots.sort((a, z) => a.date.getTime() - z.date.getTime());
    let takeArrived = arrivedDebitKg;
    let takePending = pendingDebitKg;
    for (const lot of b.lots) {
      if (lot.kind === 'ARRIVED' && takeArrived > EPS) {
        const take = Math.min(takeArrived, lot.receivedKg);
        lot.receivedKg -= take;
        lot.soldKg += take;
        takeArrived -= take;
      }
    }

    return {
      blackPricePerKg: b.blackPricePerKg,
      lorries: b.lorries,
      arrivedBlackKg: Math.round(b.arrivedBlackKg),
      // Consumable pappu this band supplied to sales (arrived + pending drawn down).
      allocatedPappuKg: Math.round(arrivedDebitKg * arrivedYield + pendingDebitKg * pendingYield),
      remainingBlackKg: Math.round(remainingBlackKg),
      remainingValue: Math.round(b.arrivedValue * remFrac * 100) / 100,
      pendingBlackKg: Math.round(remainingPendingKg),
      pendingValue: Math.round(b.pendingValue * pendFrac * 100) / 100,
      shortfallBlackKg: Math.round(b.shortfallBlackKg),
      shortfallPappuKg: Math.round(b.shortfallPappuKg),
      lots: b.lots,
    };
  });

  res.json({
    bands: result,
    totalAllocatedPappuKg: Math.round(totalAllocatedPappuKg),
    totalDeficitPappuKg: Math.round(totalDeficitPappuKg),
    outTurnPct: PAPPU_OUT_TURN * 100,
    consumablePct: PAPPU_CONSUMABLE * 100,
  });
}

/**
 * Helper to parse state from address.
 * Matches common patterns or extracts trailing two-letter words.
 */
export function parseState(address: string | null): string {
  if (!address) return 'Unknown / Other';
  const cleanAddress = address.trim().toUpperCase();

  if (/\b(AP|ANDHRA|ANDHRA\s+PRADESH)\b/.test(cleanAddress)) return 'Andhra Pradesh';
  if (/\b(TN|TAMIL|TAMIL\s+NADU)\b/.test(cleanAddress)) return 'Tamil Nadu';
  if (/\b(TS|TG|TELANGANA)\b/.test(cleanAddress)) return 'Telangana';
  if (/\b(KA|KARNATAKA)\b/.test(cleanAddress)) return 'Karnataka';
  if (/\b(KL|KERALA)\b/.test(cleanAddress)) return 'Kerala';
  if (/\b(MH|MAHARASHTRA)\b/.test(cleanAddress)) return 'Maharashtra';
  if (/\b(OD|ORISSA|ODISHA)\b/.test(cleanAddress)) return 'Odisha';

  const words = cleanAddress.split(/[\s,]+/);
  if (words.length > 0) {
    const lastWord = words[words.length - 1];
    if (lastWord.length === 2 && /^[A-Z]{2}$/.test(lastWord)) {
      return lastWord;
    }
  }

  return 'Unknown / Other';
}

/**
 * Get remaining raw black seed stock aggregated by supplier party.
 *
 * Raw seed is depleted only as pappu is actually SOLD (dispatched), NOT when it is
 * milled — milling happens automatically on arrival, so a milled-based balance would
 * collapse to ~0. This mirrors Stock by Price's remaining-black-seed model: the
 * seed-equivalent of pappu sold (pappuSold ÷ 0.6 out-turn) is drawn down across every
 * supplier's price pools MOST-EXPENSIVE-BAND FIRST.
 */
export async function getStockByParty(req: Request, res: Response) {
  const parties = await prisma.party.findMany({
    where: {
      type: { in: ['SUPPLIER', 'BOTH'] },
    },
    include: {
      purchaseOrders: {
        include: {
          stockIns: {
            include: {
              purchase: {
                include: {
                  verification: true,
                },
              },
            },
          },
        },
      },
    },
  });

  type Pool = {
    pricePerKg: number;
    totalPurchasedKg: number;
    totalMilledKg: number; // seed drawn down by pappu sold (kept name for client compat)
    netStockKg: number;
    purchasedValue: number;
    value: number;
    stockIns: any[];
  };

  // Build gross pools per party (no depletion yet) — pool seed by purchase price.
  const partyData = parties.map((party) => {
    // Keyed on a rounded-to-paise string so a verified 25.00 and a PO 25 collapse
    // into one group (raw JS numbers from Decimal can otherwise split a clean price).
    const pricePoolMap = new Map<string, Pool>();

    for (const po of party.purchaseOrders) {
      for (const stockIn of po.stockIns) {
        const purchase = stockIn.purchase;
        const price = purchase
          ? (purchase.verification
              ? Number(purchase.verification.pricePerKg)
              : Number(po.pricePerKg))
          : Number(po.pricePerKg);

        const purchasedWeightKg = purchase
          ? (purchase.verification
              ? purchase.verification.finalWeightKg
              : purchase.netWeightKg)
          : (stockIn.rvpKataKg > 0 ? stockIn.rvpKataKg : stockIn.billingWeightKg);

        if (purchasedWeightKg > 0) {
          const priceKey = price.toFixed(2);
          if (!pricePoolMap.has(priceKey)) {
            pricePoolMap.set(priceKey, {
              pricePerKg: price,
              totalPurchasedKg: 0,
              totalMilledKg: 0,
              netStockKg: 0,
              purchasedValue: 0,
              value: 0,
              stockIns: [],
            });
          }
          const pool = pricePoolMap.get(priceKey)!;
          pool.totalPurchasedKg += purchasedWeightKg;
          pool.netStockKg += purchasedWeightKg; // depleted below
          pool.purchasedValue += purchasedWeightKg * price;
          pool.value += purchasedWeightKg * price; // depleted below
          pool.stockIns.push({
            id: stockIn.id,
            arrivalDate: stockIn.arrivalDate,
            lorryNumber: stockIn.lorryNumber,
            invoiceNumber: stockIn.invoiceNumber,
            purchasedWeightKg,
            netWeightKg: purchasedWeightKg,
            poNumber: po.poNumber,
            value: purchasedWeightKg * price,
          });
        }
      }
    }

    return { party, pricePoolMap };
  });

  // Seed consumed by COMMITTED pappu sales (same basis as Stock by Price): a pappu
  // sale draws seed the moment the order is placed (max of ordered vs dispatched),
  // drawn down most-expensive-band first across every supplier's pools.
  const pappuOrders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { dispatches: { select: { weightKg: true } } },
  });
  const pappuCommittedKg = pappuOrders.reduce((sum, so) => {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(so.tonnageKg, dispatched);
  }, 0);
  let seedToDeplete = pappuCommittedKg / PAPPU_OUT_TURN;

  const allPools = partyData.flatMap((pd) => [...pd.pricePoolMap.values()]);
  allPools.sort((a, b) => b.pricePerKg - a.pricePerKg);
  for (const pool of allPools) {
    if (seedToDeplete <= 0) break;
    const take = Math.min(seedToDeplete, pool.netStockKg);
    if (take <= 0) continue;
    pool.netStockKg -= take;
    pool.value = pool.netStockKg * pool.pricePerKg;
    pool.totalMilledKg += take;
    seedToDeplete -= take;
  }

  const stockByParty = partyData.map(({ party, pricePoolMap }) => {
    const pricePools = [...pricePoolMap.values()]
      .sort((a, b) => b.pricePerKg - a.pricePerKg);

    const totalPurchasedKg = pricePools.reduce((s, p) => s + p.totalPurchasedKg, 0);
    const totalMilledKg = pricePools.reduce((s, p) => s + p.totalMilledKg, 0);
    const netStockKg = pricePools.reduce((s, p) => s + p.netStockKg, 0);
    const totalValuation = pricePools.reduce((s, p) => s + p.value, 0);
    const weightedAveragePrice = netStockKg > 0 ? totalValuation / netStockKg : 0;

    return {
      partyId: party.id,
      partyName: party.name,
      phone: party.phone || 'N/A',
      address: party.address || 'N/A',
      state: party.state || parseState(party.address),
      totalPurchasedKg,
      totalMilledKg,
      netStockKg,
      totalValuation,
      weightedAveragePrice,
      pricePools,
    };
  });

  res.json(stockByParty);
}

/**
 * Get remaining raw black seed stock aggregated by state.
 */
export async function getStockByState(req: Request, res: Response) {
  const parties = await prisma.party.findMany({
    where: {
      type: { in: ['SUPPLIER', 'BOTH'] },
    },
    include: {
      purchaseOrders: {
        include: {
          stockIns: {
            include: {
              purchase: {
                include: {
                  verification: true,
                  processing: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const stateGroups: Record<
    string,
    {
      state: string;
      totalPurchasedKg: number;
      totalMilledKg: number;
      netStockKg: number;
      supplierCount: number;
    }
  > = {};

  for (const party of parties) {
    const state = party.state || parseState(party.address);
    if (!stateGroups[state]) {
      stateGroups[state] = {
        state,
        totalPurchasedKg: 0,
        totalMilledKg: 0,
        netStockKg: 0,
        supplierCount: 0,
      };
    }

    let totalPurchasedKg = 0;
    let totalMilledKg = 0;

    for (const po of party.purchaseOrders) {
      for (const stockIn of po.stockIns) {
        if (stockIn.purchase) {
          const purchase = stockIn.purchase;
          const weight = purchase.verification
            ? purchase.verification.finalWeightKg
            : purchase.netWeightKg;

          totalPurchasedKg += weight;

          if (purchase.processing) {
            totalMilledKg += purchase.processing.blackWeightKg;
          }
        }
      }
    }

    stateGroups[state].totalPurchasedKg += totalPurchasedKg;
    stateGroups[state].totalMilledKg += totalMilledKg;
    stateGroups[state].netStockKg += totalPurchasedKg - totalMilledKg;
    stateGroups[state].supplierCount += 1;
  }

  const result = Object.values(stateGroups).sort((a, b) => b.netStockKg - a.netStockKg);
  res.json(result);
}

/**
 * Get all inventory silos.
 */
export async function getSilos(req: Request, res: Response) {
  const silos = await prisma.siloInventory.findMany();
  res.json(silos);
}

