import { prisma } from '../lib/prisma.js';
import { PAPPU_OUT_TURN, PAPPU_CONSUMABLE, landedPricePerKg } from '../lib/calc.js';

export type LotKind = 'ARRIVED' | 'PENDING' | 'SHORTFALL';

export interface Lot {
  purchaseId: string;
  date: Date;
  partyName: string;
  partyState: string;
  partyId: string;
  partyPhone: string;
  partyAddress: string;
  lorryNumber: string;
  poNumber: string | null;
  kind: LotKind;
  orderedKg: number;
  receivedKg: number;
  soldKg: number;
  pricePerKg: number;
  /** Physical location the seed currently sits at - 'RVP' (mill) or a storage location name. */
  location: string;
  consumedBy?: { saleDate: string; buyer: string; orderId: string; seedKg: number }[];
}

export interface Band {
  blackPricePerKg: number;
  lorries: number;
  arrivedBlackKg: number;
  arrivedValue: number;
  pendingBlackKg: number;
  pendingValue: number;
  shortfallBlackKg: number;
  shortfallPappuKg: number;
  lots: Lot[];
  remainingBlackKg?: number;
  remainingValue?: number;
  pendingConsumableBlackKg?: number;
  pendingBufferBlackKg?: number;
  allocatedPappuKg?: number;
}

export interface StockEngineResult {
  bands: Band[];
  totalAllocatedPappuKg: number;
  totalDeficitPappuKg: number;
  outTurnPct: number;
  consumablePct: number;
  allLots: Lot[];
  totalStorageKg: number;
}

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

import { withCache } from '../lib/cache.js';

async function _computeUnifiedStockEngine(
  allocationStrategy: 'MOST_EXPENSIVE_FIRST' | 'FIFO'
): Promise<StockEngineResult> {
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

  const storageLotsByLocation = new Map<string, Array<{
    price: number; netKg: number; value: number; date: Date;
    purchaseId: string; partyName: string; partyState: string; partyId: string; partyPhone: string; partyAddress: string; lorryNumber: string; poNumber: string | null;
  }>>();

  for (const po of purchaseOrders) {
    let totalPoNetKg = 0;
    const orderedKg = po.tonnageKg;
    let partyState = parseState(po.party.state);
    if (partyState === 'Unknown / Other' && po.party.state) {
      partyState = po.party.state.trim().split(/[\s,]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    } else if (!po.party.state) {
      partyState = parseState(po.party.address);
    }

    let hasRvpStockIn = false;
    let hasStorageStockIn = false;
    for (const si of po.stockIns) {
      if (si.loadingLocation === 'RVP') {
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

      // Party/base rate agreed at PO (or corrected at verification). This is what
      // the supplier is paid per kg - it never includes inward freight.
      const basePrice = si.purchase.verification
        ? Number(si.purchase.verification.pricePerKg)
        : Number(po.pricePerKg);
      // BASE-priced lorries book their inward freight separately (Purchase.freightCharge),
      // so the company's DELIVERY (landed) price of that seed is base + freight/kg. The
      // freight is spread over the whole-vehicle tonnage for a SHARED lorry, else this
      // arrival's net weight. The Order Planner bands and allocates on this delivered
      // price, and the band value carries the freight loading too. DELIVERY-priced POs
      // already bake freight into the quoted rate, so their freightCharge is 0 → landed == base.
      const freight = (po.priceType || 'BASE') === 'BASE' ? Number(si.purchase.freightCharge) || 0 : 0;
      const freightBasisKg = si.purchase.freightTonnageKg || netKg;
      const price = landedPricePerKg(basePrice, freightBasisKg, freight);
      const value = Math.round((netKg * price) * 100) / 100;

      if (si.loadingLocation !== 'RVP') {
        const lots = storageLotsByLocation.get(si.loadingLocation) ?? [];
        lots.push({
          price, netKg, value, date: si.arrivalDate,
          purchaseId: si.purchase.id, partyName: po.party.name, partyState, partyId: po.party.id, partyPhone: po.party.phone || '', partyAddress: po.party.address || '',
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
        partyState,
        partyId: po.party.id,
        partyPhone: po.party.phone || '',
        partyAddress: po.party.address || '',
        lorryNumber: si.lorryNumber,
        poNumber: po.poNumber,
        kind: 'ARRIVED',
        orderedKg: netKg,
        receivedKg: netKg,
        soldKg: 0,
        pricePerKg: price,
        location: 'RVP',
      });
    }

    if (hasStorageStockIn && !hasRvpStockIn) continue;

    const gapKg = Math.max(0, orderedKg - totalPoNetKg);
    if (gapKg > 0) {
      const price = Number(po.pricePerKg);

      let isStillComing = false;
      if (po.status === 'PENDING') {
        isStillComing = true;
      } else if (po.status === 'ARRIVED') {
        const hasUnpurchased = po.stockIns.some(si => !si.purchase);
        if (hasUnpurchased) {
          isStillComing = true;
        }
      }

      // STOCK-bound POs are held out of the planner's pending pool: their tonnage
      // isn't sellable-as-pending until a lorry actually lands (a direct RVP stock-in
      // creates an ARRIVED band above; a cold-storage stock-in enters via transfer).
      // This prevents pre-selling incoming stock that then re-appears at stock-in.
      // Skip before touching a band so no spurious zero-band is created.
      if (isStillComing && po.plannedLocation !== 'RVP') continue;

      const b = getBand(price);
      if (isStillComing) {
        b.pendingBlackKg += gapKg;
        b.pendingValue += gapKg * price;
        b.lots.push({
          purchaseId: `pending-${po.id}`,
          date: po.poDate,
          partyName: po.party.name,
          partyState,
          partyId: po.party.id,
          partyPhone: po.party.phone || '',
          partyAddress: po.party.address || '',
          lorryNumber: 'PENDING',
          poNumber: po.poNumber,
          kind: 'PENDING',
          orderedKg,
          receivedKg: gapKg,
          soldKg: 0,
          pricePerKg: price,
          location: 'RVP',
        });
      } else {
        // Gap between ordered and received tonnage on a completed PO is a
        // normal weighbridge variance, NOT a stock shortage. Real shortages
        // are only raised when pappu sale demand exceeds available seed
        // supply (handled by the allocation loop below). Silently ignore.
      }
    }
  }

  const transfers = await prisma.stockTransfer.findMany({
    where: { toLocation: 'RVP' },
    orderBy: { transferDate: 'asc' },
  });
  for (const t of transfers) {
    let remainingTransferKg = t.weightKg;
    if (remainingTransferKg <= 0) continue;

    const addedCostPerKg = t.weightKg > 0 ? (Number(t.loadingHamali) + Number(t.unloadingHamali) + Number(t.transportCharge)) / t.weightKg : 0;

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
        partyState: lot.partyState,
        partyId: lot.partyId,
        partyPhone: lot.partyPhone,
        partyAddress: lot.partyAddress,
        lorryNumber: lot.lorryNumber,
        poNumber: lot.poNumber,
        kind: 'ARRIVED',
        orderedKg: takenKg,
        receivedKg: takenKg,
        soldKg: 0,
        pricePerKg: newPrice,
        location: 'RVP',
      });
    }
  }

  const remainingStorageKg = new Map<string, number>();
  // Stock physically sitting in a non-RVP storage location that was never transferred
  // to the mill still belongs to the party and must appear in the whole-stock views
  // (Stock-by-State / Stock-by-Party). It has NOT been milled, so soldKg = 0 and the
  // full received weight is net stock. These lots are deliberately kept OUT of the
  // price bands so the RVP-only Pappu planner (getStockByPrice) stays unaffected.
  const storageLots: Lot[] = [];
  for (const [loc, lots] of storageLotsByLocation.entries()) {
    remainingStorageKg.set(loc, lots.reduce((s, l) => s + l.netKg, 0));
    for (const lot of lots) {
      if (lot.netKg <= EPS) continue;
      storageLots.push({
        purchaseId: lot.purchaseId,
        date: lot.date,
        partyName: lot.partyName,
        partyState: lot.partyState,
        partyId: lot.partyId,
        partyPhone: lot.partyPhone,
        partyAddress: lot.partyAddress,
        lorryNumber: lot.lorryNumber,
        poNumber: lot.poNumber,
        kind: 'ARRIVED',
        orderedKg: Math.round(lot.netKg),
        receivedKg: Math.round(lot.netKg),
        soldKg: 0,
        pricePerKg: lot.price,
        location: loc,
      });
    }
  }
  const totalStorageKg = Array.from(remainingStorageKg.values()).reduce((a, b) => a + b, 0);

  const bands = [...bandMap.values()].sort((a, b) => b.blackPricePerKg - a.blackPricePerKg);

  const pappuOrders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { dispatches: { select: { weightKg: true } }, buyer: { select: { name: true } } },
  });
  const committedPappuKg = pappuOrders.reduce((sum, so) => {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(so.tonnageKg, dispatched);
  }, 0);

  const arrivedYield = PAPPU_OUT_TURN;
  const pendingYield = PAPPU_OUT_TURN * PAPPU_CONSUMABLE;

  const assignedArrivedSeed = new Map<string, number>();
  const assignedPendingSeed = new Map<string, number>();

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
        poolRefs.push({ bandKey: b.blackPricePerKg.toFixed(2), price: b.blackPricePerKg, date: lot.date, remainingConsumableKg: lot.receivedKg * PAPPU_CONSUMABLE, lot, lotKind: 'PENDING' });
      }
    }
  }

  type Demand = { orderId: string; saleDate: Date; buyer: string; pappuNeed: number };
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
      demand: { orderId: so.id, saleDate: so.saleDate, buyer: so.buyer?.name ?? 'Unknown', pappuNeed: committed },
    });
  }
  allocEvents.sort((a, z) => a.t - z.t || (a.kind === 'arrive' ? -1 : 1));

  const activePool: PoolRef[] = [];
  const drawFromPool = (demand: Demand): number => {
    let needPappu = demand.pappuNeed;
    if (needPappu <= EPS) return 0;
    
    if (allocationStrategy === 'MOST_EXPENSIVE_FIRST') {
      activePool.sort((a, z) => (z.price - a.price) || (a.date.getTime() - z.date.getTime()));
    } else {
      activePool.sort((a, z) => (a.date.getTime() - z.date.getTime()) || (z.price - a.price));
    }

    const saleDate = demand.saleDate.toISOString().slice(0, 10);
    for (const r of activePool) {
      if (needPappu <= EPS) break;
      if (r.remainingConsumableKg <= EPS) continue;
      const yld = arrivedYield;
      const availPappu = r.remainingConsumableKg * yld;
      const takePappu = Math.min(needPappu, availPappu);
      const takeSeed = takePappu / yld;
      r.remainingConsumableKg -= takeSeed;
      if (r.lotKind === 'ARRIVED') {
        assignedArrivedSeed.set(r.bandKey, (assignedArrivedSeed.get(r.bandKey) ?? 0) + takeSeed);
      } else {
        assignedPendingSeed.set(r.bandKey, (assignedPendingSeed.get(r.bandKey) ?? 0) + takeSeed);
      }
      r.lot.consumedBy!.push({ saleDate, buyer: demand.buyer, orderId: demand.orderId, seedKg: Math.round(takeSeed) });
      needPappu -= takePappu;
    }
    return needPappu;
  };

  const backlog: Demand[] = [];
  for (const ev of allocEvents) {
    if (ev.kind === 'arrive') {
      activePool.push(ev.ref);
      while (backlog.length > 0) {
        const left = drawFromPool(backlog[0]);
        if (left > EPS) { backlog[0].pappuNeed = left; break; }
        backlog.shift();
      }
    } else {
      const left = drawFromPool(ev.demand);
      if (left > EPS) backlog.push({ ...ev.demand, pappuNeed: left });
    }
  }

  const totalDeficitPappuKg = backlog.reduce((s, d) => s + d.pappuNeed, 0);

  const allLots: Lot[] = [];
  
  for (const r of poolRefs) {
    if (r.lotKind === 'ARRIVED') {
      r.lot.soldKg = Math.round(r.lot.receivedKg - r.remainingConsumableKg);
      r.lot.receivedKg = Math.round(r.remainingConsumableKg);
    } else {
      r.lot.soldKg = Math.round(r.lot.receivedKg * PAPPU_CONSUMABLE - r.remainingConsumableKg);
      r.lot.receivedKg = Math.round(r.lot.receivedKg - r.lot.soldKg);
    }
  }

  const result = bands.map((b) => {
    const key = b.blackPricePerKg.toFixed(2);
    const arrivedDebitKg = assignedArrivedSeed.get(key) ?? 0;
    const pendingDebitKg = assignedPendingSeed.get(key) ?? 0;

    const remainingBlackKg = b.arrivedBlackKg - arrivedDebitKg;
    
    const initialPendingConsumable = b.pendingBlackKg * PAPPU_CONSUMABLE;
    const initialPendingBuffer = b.pendingBlackKg * (1 - PAPPU_CONSUMABLE);
    const remainingPendingConsumable = Math.max(0, initialPendingConsumable - pendingDebitKg);
    const remainingPendingBuffer = initialPendingBuffer;
    const remainingPendingKg = remainingPendingConsumable + remainingPendingBuffer;

    const remFrac = b.arrivedBlackKg > 0 ? remainingBlackKg / b.arrivedBlackKg : 0;
    const pendFrac = b.pendingBlackKg > 0 ? remainingPendingKg / b.pendingBlackKg : 0;

    b.arrivedBlackKg = Math.round(b.arrivedBlackKg);
    b.remainingBlackKg = Math.round(remainingBlackKg);
    b.remainingValue = Math.round(b.arrivedValue * remFrac * 100) / 100;
    b.pendingBlackKg = Math.round(remainingPendingKg);
    b.pendingConsumableBlackKg = Math.round(remainingPendingConsumable);
    b.pendingBufferBlackKg = Math.round(remainingPendingBuffer);
    b.pendingValue = Math.round(b.pendingValue * pendFrac * 100) / 100;
    b.shortfallBlackKg = Math.round(b.shortfallBlackKg);
    b.shortfallPappuKg = Math.round(b.shortfallPappuKg);
    
    for(const l of b.lots) allLots.push(l);

    return {
      ...b,
      allocatedPappuKg: Math.round(arrivedDebitKg * arrivedYield + pendingDebitKg * arrivedYield),
    };
  });

  // Surface storage-resident (un-transferred) stock in the whole-stock lot list.
  allLots.push(...storageLots);

  return {
    bands: result,
    totalAllocatedPappuKg: Math.round(committedPappuKg),
    totalDeficitPappuKg: Math.round(totalDeficitPappuKg),
    outTurnPct: PAPPU_OUT_TURN * 100,
    consumablePct: PAPPU_CONSUMABLE * 100,
    allLots,
    totalStorageKg
  };
}

export async function computeUnifiedStockEngine(
  depletionStrategy: 'FIFO' | 'MOST_EXPENSIVE_FIRST'
): Promise<StockEngineResult> {
  const cacheKey = `unified_stock_engine_${depletionStrategy}`;
  // TTL is a safety net only: any successful mutation clears this cache (see the
  // invalidation middleware in routes/index.ts), so a longer window just makes
  // read-only navigation faster without ever serving post-write stale figures.
  return withCache(cacheKey, 120, () => _computeUnifiedStockEngine(depletionStrategy));
}
