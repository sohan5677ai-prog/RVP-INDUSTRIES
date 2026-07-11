import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { SaleProduct } from '@prisma/client';
import { companyHamaliShare, calcSaleFreight } from '../lib/calc.js';
import { getFreightRateForDestination } from './settings.controller.js';

/**
 * Detailed black seed stock rows: one per recorded purchase (lorry), PLUS synthetic
 * transferred-in rows at RVP for seed moved from storage. Milling does NOT remove
 * seed from this list - raw black seed is only depleted when the finished pappu is
 * sold. Shared by getBlackSeedStock and the per-order pappu margin so both read the
 * same arrived-at-process seed timeline. Value = seed cost + the company's half of
 * the hamali.
 */
export async function computeBlackSeedRows() {
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

    // Stock is valued EXCLUDING GST - the input IGST paid on a purchase is claimable
    // tax credit, not a cost of the stock. Use physical weight × price so a shortage
    // can't inflate the unit price.
    const seedCostWithoutGst = rvpNetWeightKg * price;

    const value = Math.round((seedCostWithoutGst + ourHamali + freight) * 100) / 100;

    const priceType = p.stockIn.purchaseOrder.priceType || 'BASE';
    const isBasePrice = priceType === 'BASE';
    const addedFreight = isBasePrice ? freight : 0;

    const valueExclGstAndHamali = Math.round((seedCostWithoutGst + addedFreight) * 100) / 100;
    const valueExclHamali = Math.round((seedCostWithoutGst + addedFreight) * 100) / 100;

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
      isTransferredIn: false as boolean,
      fromLocation: null as string | null,
    };
  });

  // Storage-location seed that has since moved to RVP via a StockTransfer (Stock
  // Transfer page) is physically at the process now, so it should show up here too
  // - as a synthetic row (location 'RVP') for the transferred portion, dated on the
  // TRANSFER date (not the original arrival date), since that's when it actually
  // reached the process. Depletes storage by BAND PRICE (most-expensive seed first,
  // oldest lot within a band), matching the Stock by Location / Order Planner
  // allocation engine - a transfer draws down the priciest seed first, NOT FIFO by
  // arrival date. Transfers are applied oldest-transfer-first. The original row is
  // left untouched; any untransferred remainder is still sitting in storage and stays
  // excluded, same as before.
  const storageRowsByLocation = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.location === 'RVP' || row.location === 'At process') continue;
    const list = storageRowsByLocation.get(row.location) ?? [];
    list.push(row);
    storageRowsByLocation.set(row.location, list);
  }
  for (const list of storageRowsByLocation.values()) {
    // Highest price first; oldest lot first within the same price band.
    list.sort((a, z) => (z.pricePerKg - a.pricePerKg) || (a.date.getTime() - z.date.getTime()));
  }
  // Remaining (undepleted) kg per storage row, drawn down across transfers in date order.
  const remainingByPurchaseId = new Map<string, number>();
  for (const list of storageRowsByLocation.values()) {
    for (const row of list) remainingByPurchaseId.set(row.purchaseId, row.rvpNetWeightKg);
  }

  const transfersToRvp = await prisma.stockTransfer.findMany({
    where: { toLocation: 'RVP' },
    orderBy: { transferDate: 'asc' },
  });
  for (const t of transfersToRvp) {
    let remainingTransferKg = t.weightKg;
    if (remainingTransferKg <= 0) continue;

    const addedCostPerKg = t.weightKg > 0 ? (Number(t.loadingHamali) + Number(t.unloadingHamali) + Number(t.transportCharge)) / t.weightKg : 0;

    const sourceRows = storageRowsByLocation.get(t.fromLocation) ?? [];

    for (const row of sourceRows) {
      if (remainingTransferKg <= 0) break;
      const availableKg = remainingByPurchaseId.get(row.purchaseId) ?? 0;
      if (availableKg <= 0) continue;
      const takenKg = Math.min(remainingTransferKg, availableKg);
      if (takenKg <= 0) continue;
      remainingTransferKg -= takenKg;
      remainingByPurchaseId.set(row.purchaseId, availableKg - takenKg);
      const frac = takenKg / row.rvpNetWeightKg;

      rows.push({
        ...row,
        purchaseId: `${row.purchaseId}-transfer-${t.id}`,
        date: t.transferDate,
        rvpNetWeightKg: takenKg,
        location: 'RVP',
        pricePerKg: Math.round((row.pricePerKg + addedCostPerKg) * 100) / 100,
        hamaliCharge: Math.round(row.hamaliCharge * frac * 100) / 100,
        companyHamali: Math.round(row.companyHamali * frac * 100) / 100,
        value: Math.round((row.value * frac + (takenKg * addedCostPerKg)) * 100) / 100,
        valueExclGstAndHamali: Math.round((row.valueExclGstAndHamali * frac + (takenKg * addedCostPerKg)) * 100) / 100,
        valueExclHamali: Math.round((row.valueExclHamali * frac + (takenKg * addedCostPerKg)) * 100) / 100,
        isTransferredIn: true,
        fromLocation: t.fromLocation,
      });
    }
  }

  return rows;
}

/**
 * Detailed black seed stock endpoint: the rows above plus pappu/husk/waste sold &
 * committed aggregates the Stock pages need.
 */
export async function getBlackSeedStock(_req: Request, res: Response) {
  const rows = await computeBlackSeedRows();

  // Product sold = all dispatched shipments (RVP kata weight). Pappu nets down the
  // raw pool; husk/waste net down their own derived availability.
  const dispatches = await prisma.saleDispatch.findMany({
    select: { weightKg: true, saleOrder: { select: { product: true } } },
  });
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

  // Committed amounts drive depletion. A sale draws down the moment the ORDER is placed.
  const getCommittedKg = async (product: SaleProduct) => {
    const orders = await prisma.saleOrder.findMany({
      where: { product },
      include: { dispatches: { select: { weightKg: true } } },
    });
    return orders.reduce((sum, so) => {
      const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
      return sum + Math.max(so.tonnageKg, dispatched);
    }, 0);
  };
  const pappuCommittedKg = await getCommittedKg('PAPPU');
  const huskCommittedKg = await getCommittedKg('HUSK');
  const wasteCommittedKg = await getCommittedKg('WASTE');

  // Total black seed consumed in milling (pappu sold + black seed consumed on it).
  // This is the authoritative raw-stock depletion figure: once seed enters the mill
  // it is no longer raw, regardless of whether the output pappu has been sold yet.
  const milledAgg = await prisma.processing.aggregate({ _sum: { blackWeightKg: true } });
  const totalMilledKg = milledAgg._sum.blackWeightKg ?? 0;

  // Total tonnage committed across all live (non-cancelled) purchase orders,
  // used to project the pappu we are committed to producing (60% out-turn).
  const pos = await prisma.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' } },
    include: { stockIns: { select: { rvpKataKg: true } } },
  });
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
  //   ARRIVED  - seed physically received (CREDIT)
  //   PENDING  - un-arrived tonnage of a still-OPEN (PENDING) PO (future CREDIT,
  //              depletable by sales after arrived seed runs out)
  //   SHORTFALL - gap on a PO that has already arrived (ARRIVED/COMPLETED) but
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
    // Traceability: which sale orders drew this (ARRIVED) lot's seed, and how much.
    // Populated by the date-aware chronological allocation below.
    consumedBy?: { saleDate: string; buyer: string; seedKg: number }[];
  }
  interface Band {
    blackPricePerKg: number;
    lorries: number;
    // ARRIVED pool - physically at process (CREDIT)
    arrivedBlackKg: number;   // gross arrived
    arrivedValue: number;     // value of gross arrived
    // PENDING pool - ordered on still-open POs, not yet arrived (future CREDIT)
    pendingBlackKg: number;
    pendingValue: number;
    // SHORTFALL - seed an already-arrived PO failed to deliver (CREDIT that never came)
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

  // Seed delivered straight to a storage silo (Rampalli/Murugan/Multi) hasn't
  // reached the process yet, so it isn't a price-band credit on its own - it only
  // becomes one once a StockTransfer physically moves it to RVP (handled in step 2
  // below, FIFO by arrival date). Collected here per storage location as we scan
  // stock-ins, so step 2 has something to draw against.
  const storageLotsByLocation = new Map<string, Array<{
    price: number; netKg: number; value: number; date: Date;
    purchaseId: string; partyName: string; lorryNumber: string; poNumber: string | null;
  }>>();

  // 1. Build bands: arrived lorries (CREDIT) + un-arrived ordered tonnage, split into
  //    PENDING (open PO, still coming) vs SHORTFALL (arrived PO that came up short).
  for (const po of purchaseOrders) {
    let totalPoNetKg = 0;
    const orderedKg = po.tonnageKg; // original order, never overwritten

    // Track whether any stock-in on this PO went to RVP / At process vs cold storage.
    // Checked for ALL stock-ins (even those without a purchase entry yet) so that
    // storage-only POs (Murugan, PGR COLD, KNM Multi) don't create phantom
    // SHORTFALL / PENDING lots in the Order Planner — their gap belongs to the
    // cold-storage tracking pages, not the process-level planner.
    let hasRvpStockIn = false;
    let hasStorageStockIn = false;
    for (const si of po.stockIns) {
      if (si.loadingLocation === 'At process' || si.loadingLocation === 'RVP') {
        hasRvpStockIn = true;
      } else {
        hasStorageStockIn = true;
      }
    }

    for (const si of po.stockIns) {
      if (!si.purchase) continue;
      const netKg = si.purchase.netWeightKg;
      if (netKg <= 0) continue;
      totalPoNetKg += netKg;

      const price = si.purchase.verification
        ? Number(si.purchase.verification.pricePerKg)
        : Number(po.pricePerKg);
      // As requested, seed value strictly equals base price (excluding inward hamali/freight)
      const value = Math.round((netKg * price) * 100) / 100;

      if (si.loadingLocation !== 'At process' && si.loadingLocation !== 'RVP') {
        const lots = storageLotsByLocation.get(si.loadingLocation) ?? [];
        lots.push({
          price, netKg, value, date: si.arrivalDate,
          purchaseId: si.purchase.id, partyName: po.party.name,
          lorryNumber: si.lorryNumber, poNumber: po.poNumber,
        });
        storageLotsByLocation.set(si.loadingLocation, lots);
        continue;
      }

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

    // Storage-only POs (e.g. Murugan/MRG, PGR COLD, KNM Multi): their gap belongs
    // to the cold-storage pages, not the Order Planner. Skip the gap entirely so no
    // SHORTFALL or PENDING lot is created in the price bands.
    if (hasStorageStockIn && !hasRvpStockIn) continue;

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

  // 2. Storage seed that has since been moved to the process via a StockTransfer
  //    (Stock Transfer page) becomes an ARRIVED credit too. The transfer's costs
  //    (hamali + transport) are added to the seed's original purchase price, placing
  //    it in a higher price band (e.g. 28.00 + 0.32 = 28.32). The lot date becomes
  //    the transfer date, marking when it physically arrived at the process.
  const transfers = await prisma.stockTransfer.findMany({
    where: { toLocation: 'RVP' },
    orderBy: { transferDate: 'asc' },
  });
  for (const t of transfers) {
    let remainingTransferKg = t.weightKg;
    if (remainingTransferKg <= 0) continue;

    const addedCostPerKg = t.weightKg > 0 ? (Number(t.loadingHamali) + Number(t.unloadingHamali) + Number(t.transportCharge)) / t.weightKg : 0;

    // Match backend transfer logic: highest price first, then oldest lot.
    const lots = (storageLotsByLocation.get(t.fromLocation) ?? [])
      .sort((a, z) => (z.price - a.price) || (a.date.getTime() - z.date.getTime()));

    for (const lot of lots) {
      if (remainingTransferKg <= 0) break;
      const takenKg = Math.min(remainingTransferKg, lot.netKg);
      if (takenKg <= 0) continue;
      
      const frac = takenKg / lot.netKg;
      const valueTaken = lot.value * frac;
      
      lot.netKg -= takenKg;
      lot.value -= valueTaken;
      remainingTransferKg -= takenKg;

      const newPrice = Math.round((lot.price + addedCostPerKg) * 100) / 100;
      
      const b = getBand(newPrice);
      b.lorries += 1;
      b.arrivedBlackKg += takenKg;
      b.arrivedValue += valueTaken + (takenKg * addedCostPerKg);
      b.lots.push({
        purchaseId: `${lot.purchaseId}-transfer-${t.id}`,
        date: t.transferDate,
        partyName: lot.partyName,
        lorryNumber: lot.lorryNumber,
        poNumber: lot.poNumber,
        kind: 'ARRIVED',
        orderedKg: takenKg,
        receivedKg: takenKg,
        soldKg: 0,
      });
    }
  }

  const bands = [...bandMap.values()].sort((a, b) => b.blackPricePerKg - a.blackPricePerKg);

  // ── DEBIT: actual pappu committed to customers ───────────────────────────────
  // Driven by REAL sales, not SaleAllocation records: committed pappu = what has
  // shipped (SaleDispatch) PLUS what is still open on un-shipped orders. Sale tonnage
  // is CONSUMABLE pappu (what the customer receives).
  const pappuOrders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { dispatches: { select: { weightKg: true } }, buyer: { select: { name: true } } },
  });
  const committedPappuKg = pappuOrders.reduce((sum, so) => {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(so.tonnageKg, dispatched); // sold + still-open footprint
  }, 0);

  const arrivedYield = PAPPU_OUT_TURN;
  const pendingYield = PAPPU_OUT_TURN * PAPPU_CONSUMABLE;

  const assignedArrivedSeed = new Map<string, number>(); // band key → arrived seed debited
  const assignedPendingSeed = new Map<string, number>(); // band key → pending seed debited

  // ── UNIFIED DATE-AWARE chronological allocation ──────────────────────────────
  // Both ARRIVED and PENDING lots enter the same pool, each at their own date
  // (arrival date for arrived seed, PO date for pending PO seed). A sale order can
  // only draw from lots that entered the pool on/before the sale's date. Within the
  // pool at any moment, lots are drawn MOST-EXPENSIVE FIRST (oldest lot to break
  // ties within a band). This ensures:
  //   1. Expensive PO bands (e.g. ₹27.80) are consumed before cheap arrived bands
  //      (e.g. ₹26.50) - the "Expensive First" rule.
  //   2. Date-awareness is preserved - a July transfer can't be eaten by an April
  //      sale; backdated orders only see stock available at their time.
  //   3. Committed pappu drops by EXACTLY the sale tonnage - arrived/pending draws
  //      are tracked separately so the client formula (Available + Pending = Committed)
  //      holds precisely.
  //
  // Yield differs by lot type: ARRIVED seed yields 0.6 pappu/kg (full out-turn);
  // PENDING seed yields 0.48 pappu/kg (0.6 × 0.8, with 20% buffer deduction).
  // The draw function works in PAPPU kg and converts to seed per-lot.
  type PoolRef = {
    bandKey: string; price: number; date: Date;
    remainingConsumableKg: number; lot: Lot; lotKind: 'ARRIVED' | 'PENDING';
  };
  const poolRefs: PoolRef[] = [];
  for (const b of bands) {
    for (const lot of b.lots) {
      if (lot.kind === 'ARRIVED') {
        lot.consumedBy = [];
        poolRefs.push({ bandKey: b.blackPricePerKg.toFixed(2), price: b.blackPricePerKg, date: lot.date, remainingConsumableKg: lot.receivedKg, lot, lotKind: 'ARRIVED' });
      } else if (lot.kind === 'PENDING') {
        lot.consumedBy = [];
        // Pending lots only offer their consumable portion (80%) for sales
        poolRefs.push({ bandKey: b.blackPricePerKg.toFixed(2), price: b.blackPricePerKg, date: lot.date, remainingConsumableKg: lot.receivedKg * PAPPU_CONSUMABLE, lot, lotKind: 'PENDING' });
      }
    }
  }

  type Demand = { saleDate: Date; buyer: string; pappuNeed: number };
  type AllocEvent =
    | { t: number; kind: 'arrive'; ref: PoolRef }
    | { t: number; kind: 'sale'; demand: Demand };
  const allocEvents: AllocEvent[] = [];
  for (const r of poolRefs) allocEvents.push({ t: r.date.getTime(), kind: 'arrive', ref: r });
  for (const so of pappuOrders) {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    const committed = Math.max(so.tonnageKg, dispatched);
    if (committed > 0) allocEvents.push({
      t: so.saleDate.getTime(),
      kind: 'sale',
      demand: { saleDate: so.saleDate, buyer: so.buyer?.name ?? 'Unknown', pappuNeed: committed },
    });
  }
  // Same day: process arrivals before sales, so same-day seed can back a same-day sale.
  allocEvents.sort((a, z) => a.t - z.t || (a.kind === 'arrive' ? -1 : 1));

  const activePool: PoolRef[] = [];
  // Draw `demand.pappuNeed` (in pappu kg) from the seed available so far - dearest
  // first, oldest lot to break ties. Converts pappu→seed per-lot using the lot's
  // yield. Since we are now ONLY drawing from consumable seed, both arrived and
  // pending lots yield 0.6. Returns the pappu left unfilled.
  const drawFromPool = (demand: Demand): number => {
    let needPappu = demand.pappuNeed;
    if (needPappu <= EPS) return 0;
    activePool.sort((a, z) => (z.price - a.price) || (a.date.getTime() - z.date.getTime()));
    const saleDate = demand.saleDate.toISOString().slice(0, 10);
    for (const r of activePool) {
      if (needPappu <= EPS) break;
      if (r.remainingConsumableKg <= EPS) continue;
      const yld = arrivedYield; // Both arrived and pending now yield 0.6 from their consumable portion
      const availPappu = r.remainingConsumableKg * yld;
      const takePappu = Math.min(needPappu, availPappu);
      const takeSeed = takePappu / yld;
      r.remainingConsumableKg -= takeSeed;
      if (r.lotKind === 'ARRIVED') {
        assignedArrivedSeed.set(r.bandKey, (assignedArrivedSeed.get(r.bandKey) ?? 0) + takeSeed);
      } else {
        assignedPendingSeed.set(r.bandKey, (assignedPendingSeed.get(r.bandKey) ?? 0) + takeSeed);
      }
      r.lot.consumedBy!.push({ saleDate, buyer: demand.buyer, seedKg: Math.round(takeSeed) });
      needPappu -= takePappu;
    }
    return needPappu;
  };

  // Unfilled demand is queued (a backorder) and served, oldest-first, by the next
  // lot to enter the pool - never by a lot that enters long after the sale.
  const backlog: Demand[] = [];
  for (const ev of allocEvents) {
    if (ev.kind === 'arrive') {
      activePool.push(ev.ref);
      while (backlog.length > 0) {
        const left = drawFromPool(backlog[0]);
        if (left > EPS) { backlog[0].pappuNeed = left; break; } // pool exhausted again
        backlog.shift();
      }
    } else {
      const left = drawFromPool(ev.demand);
      if (left > EPS) backlog.push({ ...ev.demand, pappuNeed: left });
    }
  }

  // Whatever could not be drawn from arrived + pending seed is the over-commitment
  // deficit (in pappu kg).
  const totalDeficitPappuKg = backlog.reduce((s, d) => s + d.pappuNeed, 0);
  const totalAllocatedPappuKg = committedPappuKg;

  // Persist each lot's remaining seed / consumed seed from the unified allocation.
  for (const r of poolRefs) {
    if (r.lotKind === 'ARRIVED') {
      r.lot.soldKg = Math.round(r.lot.receivedKg - r.remainingConsumableKg);
      r.lot.receivedKg = Math.round(r.remainingConsumableKg);
    } else {
      // For pending lots, soldKg tracks the consumable seed sold.
      r.lot.soldKg = Math.round(r.lot.receivedKg * PAPPU_CONSUMABLE - r.remainingConsumableKg);
      // The remaining gross seed is the original gross minus the sold consumable seed.
      r.lot.receivedKg = Math.round(r.lot.receivedKg - r.lot.soldKg);
    }
  }

  const result = bands.map((b) => {
    const key = b.blackPricePerKg.toFixed(2);
    const arrivedDebitKg = assignedArrivedSeed.get(key) ?? 0;
    const pendingDebitKg = assignedPendingSeed.get(key) ?? 0;

    const remainingBlackKg = b.arrivedBlackKg - arrivedDebitKg;   // arrived seed left (≥ 0)
    
    // For pending, separate the consumable and buffer portions so the client doesn't 
    // accidentally treat the untouched buffer as sellable.
    const initialPendingConsumable = b.pendingBlackKg * PAPPU_CONSUMABLE;
    const initialPendingBuffer = b.pendingBlackKg * (1 - PAPPU_CONSUMABLE);
    const remainingPendingConsumable = Math.max(0, initialPendingConsumable - pendingDebitKg);
    const remainingPendingBuffer = initialPendingBuffer; // buffer is untouched by sales
    const remainingPendingKg = remainingPendingConsumable + remainingPendingBuffer;

    // Value tracks only the seed still on the books for this band.
    const remFrac = b.arrivedBlackKg > 0 ? remainingBlackKg / b.arrivedBlackKg : 0;
    const pendFrac = b.pendingBlackKg > 0 ? remainingPendingKg / b.pendingBlackKg : 0;

    return {
      blackPricePerKg: b.blackPricePerKg,
      lorries: b.lorries,
      arrivedBlackKg: Math.round(b.arrivedBlackKg),
      // Consumable pappu this band supplied to sales (arrived + pending drawn down).
      // Both now yielded at 0.6 because we only drew from the consumable portion.
      allocatedPappuKg: Math.round(arrivedDebitKg * arrivedYield + pendingDebitKg * arrivedYield),
      remainingBlackKg: Math.round(remainingBlackKg),
      remainingValue: Math.round(b.arrivedValue * remFrac * 100) / 100,
      pendingBlackKg: Math.round(remainingPendingKg),
      pendingConsumableBlackKg: Math.round(remainingPendingConsumable),
      pendingBufferBlackKg: Math.round(remainingPendingBuffer),
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
 * milled - milling happens automatically on arrival, so a milled-based balance would
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

  // Build gross pools per party (no depletion yet) - pool seed by purchase price.
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

export async function getCalculatorDefaults(req: Request, res: Response) {
  // Latest black seed price
  const latestPo = await prisma.purchaseOrder.findFirst({
    orderBy: { poDate: 'desc' },
  });
  const blackSeedPrice = latestPo ? Number(latestPo.pricePerKg) : 20;

  // Latest husk sale price
  const latestHuskSale = await prisma.saleOrder.findFirst({
    where: { product: 'HUSK' },
    orderBy: { saleDate: 'desc' },
  });
  const huskPrice = latestHuskSale ? Number(latestHuskSale.ratePerKg) : 1.5;

  // Latest waste sale price
  const latestWasteSale = await prisma.saleOrder.findFirst({
    where: { product: 'WASTE' },
    orderBy: { saleDate: 'desc' },
  });
  const wastePrice = latestWasteSale ? Number(latestWasteSale.ratePerKg) : 1.0;

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
export async function computePappuOrderMargins() {
  const EPS = 1e-6;

  // Arrived-at-process seed timeline (real RVP lorries + transferred-in, repriced).
  const rows = await computeBlackSeedRows();
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

export async function getPappuOrderMargins(_req: Request, res: Response) {
  res.json(await computePappuOrderMargins());
}

