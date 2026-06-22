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
    const bagCut = Number(p.bagCuttingCharge);
    const freight = Number(p.freightCharge);
    // RVP net (kata) weight of black seed received.
    const rvpNetWeightKg = p.netWeightKg;
    // Seed cost: verified payable if approved, else weight x price.
    const seedCost = p.verification ? Number(p.verification.totalAmount) : rvpNetWeightKg * price;
    const value = Math.round((seedCost + ourHamali + bagCut + freight) * 100) / 100;

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
      bagCount: p.bagCount,
      bagCuttingCharge: bagCut,
      value,
      verified: !!p.verification,
    };
  });

  // Product sold = dispatched/reached sale orders (RVP kata weight). Pappu nets
  // down the raw pool; husk/waste net down their own derived availability.
  const soldByProduct = await prisma.saleOrder.groupBy({
    by: ['product'],
    _sum: { tonnageKg: true },
    where: { status: { in: ['DISPATCHED', 'REACHED'] } },
  });
  const soldKg = (product: string) =>
    soldByProduct.find((s) => s.product === product)?._sum.tonnageKg ?? 0;
  const pappuSoldKg = soldKg('PAPPU');
  const huskSoldKg = soldKg('HUSK');
  const wasteSoldKg = soldKg('WASTE');

  // Total tonnage committed across all live (non-cancelled) purchase orders,
  // used to project the pappu we are committed to producing (60% out-turn).
  const poTonnageAgg = await prisma.purchaseOrder.aggregate({
    _sum: { tonnageKg: true },
    where: { status: { not: 'CANCELLED' } },
  });
  const poTonnageKg = poTonnageAgg._sum.tonnageKg ?? 0;

  res.json({ rows, pappuSoldKg, huskSoldKg, wasteSoldKg, poTonnageKg });
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
                  processing: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const stockByParty = parties.map((party) => {
    let totalPurchasedKg = 0;
    let totalMilledKg = 0;

    // Pool stock-ins by their purchase price so the UI can show, per supplier,
    // exactly how much was bought at each ₹/kg. Keyed on a rounded-to-paise
    // string so that e.g. a verified 25.00 and a PO 25 collapse into one group
    // (raw JS numbers from Decimal can otherwise split a clean price apart).
    const pricePoolMap = new Map<string, {
      pricePerKg: number;
      totalPurchasedKg: number;
      totalMilledKg: number;
      netStockKg: number;
      purchasedValue: number;
      value: number;
      stockIns: any[];
    }>();

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

        const milledWeightKg = (purchase && purchase.processing)
          ? purchase.processing.blackWeightKg
          : 0;

        const netWeightKg = Math.max(0, purchasedWeightKg - milledWeightKg);

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
          pool.totalMilledKg += milledWeightKg;
          pool.netStockKg += netWeightKg;
          pool.purchasedValue += purchasedWeightKg * price;
          pool.value += netWeightKg * price;
          pool.stockIns.push({
            id: stockIn.id,
            arrivalDate: stockIn.arrivalDate,
            lorryNumber: stockIn.lorryNumber,
            invoiceNumber: stockIn.invoiceNumber,
            purchasedWeightKg,
            milledWeightKg,
            netWeightKg,
            poNumber: po.poNumber,
            value: netWeightKg * price,
          });

          totalPurchasedKg += purchasedWeightKg;
          totalMilledKg += milledWeightKg;
        }
      }
    }

    const netStockKg = Math.max(0, totalPurchasedKg - totalMilledKg);
    const pricePools = [...pricePoolMap.values()]
      .sort((a, b) => b.pricePerKg - a.pricePerKg);

    const totalValuation = pricePools.reduce((sum, p) => sum + p.value, 0);
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

