import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const purchaseOrders = await prisma.purchaseOrder.findMany({
    include: {
      party: true,
      stockIns: {
        include: { purchase: { include: { verification: true } } },
      },
    },
    orderBy: { poDate: 'desc' },
  });

  const bandMap = new Map();
  const getBand = (price: number) => {
    const key = price.toFixed(2);
    let b = bandMap.get(key);
    if (!b) {
      b = { blackPricePerKg: price, lorries: 0, arrivedBlackKg: 0, arrivedValue: 0, pendingBlackKg: 0, pendingValue: 0, shortfallBlackKg: 0, shortfallPappuKg: 0, lots: [] };
      bandMap.set(key, b);
    }
    return b;
  };

  const storageLotsByLocation = new Map();

  for (const po of purchaseOrders) {
    let totalPoNetKg = 0;
    const orderedKg = po.tonnageKg;

    for (const si of po.stockIns) {
      if (!si.purchase) continue;
      const netKg = si.purchase.netWeightKg;
      if (netKg <= 0) continue;
      totalPoNetKg += netKg;

      const price = si.purchase.verification
        ? Number(si.purchase.verification.pricePerKg)
        : Number(po.pricePerKg);
      
      const value = Math.round((netKg * price) * 100) / 100;

      if (si.loadingLocation !== 'At process' && si.loadingLocation !== 'RVP') {
        const lots = storageLotsByLocation.get(si.loadingLocation) ?? [];
        lots.push({
          purchaseId: si.purchase.id,
          date: si.arrivalDate,
          partyName: po.party.name,
          lorryNumber: si.lorryNumber ?? '',
          poNumber: po.poNumber,
          price,
          netKg,
          value,
        });
        storageLotsByLocation.set(si.loadingLocation, lots);
      } else {
        const b = getBand(price);
        b.lorries += 1;
        b.arrivedBlackKg += netKg;
        b.arrivedValue += value;
        b.lots.push({
          purchaseId: si.purchase.id,
          date: si.arrivalDate,
          partyName: po.party.name,
          lorryNumber: si.lorryNumber ?? '',
          poNumber: po.poNumber,
          kind: 'ARRIVED',
          orderedKg: netKg,
          receivedKg: netKg,
          soldKg: 0,
        });
      }
    }

    const gapKg = Math.max(0, orderedKg - totalPoNetKg);
    if (gapKg > 0) {
      const price = Number(po.pricePerKg);
      const b = getBand(price);
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
        b.shortfallBlackKg += gapKg;
        b.shortfallPappuKg += gapKg * 0.6; 
        b.lots.push({
          purchaseId: `shortfall-${po.id}`,
          date: po.poDate,
          partyName: po.party.name,
          lorryNumber: 'SHORTFALL',
          poNumber: po.poNumber,
          kind: 'SHORTFALL',
          orderedKg,
          receivedKg: gapKg,
          soldKg: 0,
        });
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

  const pappuOrders = await prisma.saleOrder.findMany({
    where: { product: 'PAPPU' },
    include: { dispatches: { select: { weightKg: true } } },
  });
  const committedPappuKg = pappuOrders.reduce((sum, so) => {
    const dispatched = so.dispatches.reduce((s, d) => s + d.weightKg, 0);
    return sum + Math.max(so.tonnageKg, dispatched);
  }, 0);

  const arrivedYield = 0.6;
  const pendingYield = 0.48;

  const assignedArrivedSeed = new Map<string, number>();
  const assignedPendingSeed = new Map<string, number>();

  let remainingDebit = committedPappuKg;

  // Pass 1: arrived seed only.
  for (const b of bands) {
    if (remainingDebit <= 0.001) break;
    const arrivedConsumableAvail = b.arrivedBlackKg * arrivedYield;
    const take = Math.min(remainingDebit, arrivedConsumableAvail);
    if (take > 0) {
      assignedArrivedSeed.set(b.blackPricePerKg.toFixed(2), take / arrivedYield);
      remainingDebit -= take;
    }
  }

  // Pass 2: pending seed.
  for (const b of bands) {
    if (remainingDebit <= 0.001) break;
    const pendingConsumableAvail = b.pendingBlackKg * pendingYield;
    const take = Math.min(remainingDebit, pendingConsumableAvail);
    if (take > 0) {
      assignedPendingSeed.set(b.blackPricePerKg.toFixed(2), take / pendingYield);
      remainingDebit -= take;
    }
  }

  const totalDeficitPappuKg = remainingDebit;

  console.log(`TOTAL COMMITTED SALES PAPPU: ${committedPappuKg.toFixed(2)} KG`);
  console.log(`OVERALL DEFICIT (Unfulfilled Sales): ${totalDeficitPappuKg.toFixed(2)} KG`);
  console.log(`\n--- PRICE BAND BREAKDOWN ---`);

  for (const b of bands) {
    const key = b.blackPricePerKg.toFixed(2);
    const arrivedDebitKg = assignedArrivedSeed.get(key) ?? 0;
    const pendingDebitKg = assignedPendingSeed.get(key) ?? 0;
    const remainingBlackKg = b.arrivedBlackKg - arrivedDebitKg;
    const allocatedPappuKg = arrivedDebitKg * arrivedYield + pendingDebitKg * pendingYield;

    if (b.arrivedBlackKg > 0 || b.pendingBlackKg > 0 || b.shortfallBlackKg > 0) {
      console.log(`Band ₹${key}:`);
      console.log(`  Arrived Seed: ${b.arrivedBlackKg.toFixed(2)} kg`);
      console.log(`  Seed Deducted by Sales: ${arrivedDebitKg.toFixed(2)} kg`);
      console.log(`  Seed Remaining (Available): ${remainingBlackKg.toFixed(2)} kg`);
      console.log(`  Supplied to Sales (Committed Pappu): ${allocatedPappuKg.toFixed(2)} kg`);
      if (b.shortfallBlackKg > 0) {
        console.log(`  PO Shortfall Deficit: ${b.shortfallBlackKg.toFixed(2)} kg`);
      }
      console.log(`------------------------------`);
    }
  }
}
main().finally(() => prisma.$disconnect());
